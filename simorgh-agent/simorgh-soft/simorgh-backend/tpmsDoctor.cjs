#!/usr/bin/env node
/**
 * tpmsDoctor — why is /api/tpms/* timing out?
 *
 * A "Query inactivity timeout" only says the query never answered. This opens
 * its own fresh connection (so the app's pool is out of the picture) and walks
 * a ladder of probes, from "can we reach the host" up to the exact statement
 * /api/tpms/projects runs, timing each one and asking MySQL what the thread is
 * doing while it waits. Where the ladder stops, and what the server says the
 * thread's state is, names the cause:
 *
 *   stops at [1]/[2]        network or credentials
 *   everything fast         the app's pooled socket was the problem, not the DB
 *   COUNT(*) slow           the view itself is expensive to materialise
 *   only ORDER BY slow      the sort is the cost — drop it, sort in Node
 *   "Waiting for table
 *    metadata lock"         something else is holding the base tables
 *
 * CommonJS (.cjs) on purpose: the backend is ESM and this runs as a one-off.
 *
 * Run:  docker compose cp simorgh-soft/simorgh-backend/tpmsDoctor.cjs \
 *         simorgh-soft:/tmp/tpmsDoctor.cjs
 *       docker compose exec simorgh-soft node /tmp/tpmsDoctor.cjs
 */
const net = require('net');
const mysql = require('/app/node_modules/mysql2/promise');

const cfg = {
  host: process.env.MYSQL_HOST || '192.168.1.148',
  port: parseInt(process.env.MYSQL_PORT, 10) || 3306,
  user: process.env.MYSQL_USER || 'technical',
  password: process.env.MYSQL_PASSWORD || 'HoJETA',
  database: process.env.MYSQL_DATABASE || 'TPMS',
  connectTimeout: 15000,
};

const APP_TIMEOUT  = Number(process.env.TPMS_QUERY_TIMEOUT_MS || 60000);
// Each probe is bounded so a hang costs one probe, not the whole run.
const PROBE_MS     = Number(process.env.DOCTOR_PROBE_MS || 30000);

const VIEW = 'View_Project_Main';

// What Eplanix's C# effectively sends: three columns, no sort.
const AS_CSHARP = `SELECT IDProjectMain, OENUM, Project_Name FROM ${VIEW}`;
// What /api/tpms/projects sends today.
const AS_APP = `
  SELECT IDProjectMain AS value,
         COALESCE(OENUM, '') AS code,
         COALESCE(Project_Name, '') AS name,
         CONCAT(COALESCE(OENUM, ''), ' ', COALESCE(Project_Name, '')) AS text
  FROM ${VIEW}
  ORDER BY Project_Name`;
// The same minus the sort, to price the ORDER BY on its own.
const AS_APP_NO_SORT = AS_APP.replace(/\s*ORDER BY Project_Name\s*$/, '');

function tcpProbe(host, port, ms = 10000) {
  return new Promise(resolve => {
    const t = Date.now();
    const sock = new net.Socket();
    const done = o => { sock.destroy(); resolve({ ...o, ms: Date.now() - t }); };
    sock.setTimeout(ms);
    sock.once('connect', () => done({ ok: true }));
    sock.once('timeout', () => done({ ok: false, why: 'no SYN-ACK (silently dropped)' }));
    sock.once('error', e => done({ ok: false, why: e.code || e.message }));
    sock.connect(port, host);
  });
}

/** Poll SHOW PROCESSLIST on a second connection and report our thread's state
 *  as it changes — "Creating sort index", "Sending data", "Waiting for table
 *  metadata lock" are each a different diagnosis. Best-effort: needs PROCESS. */
function watchThread(watchConn, threadId, into) {
  let last = null;
  const timer = setInterval(() => {
    watchConn.query({ sql: 'SHOW PROCESSLIST', timeout: 5000 }).then(([rows]) => {
      const me = rows.find(r => Number(r.Id) === Number(threadId));
      if (!me) return;
      const state = String(me.State || '-');
      if (state !== last) {
        last = state;
        // Collected, not printed: this probe's result line is not written yet,
        // and interleaving the two makes the output unreadable once piped.
        into.push(`         ├─ ${String(me.Time).padStart(3)}s  ${state}`);
      }
    }).catch(() => { /* best effort */ });
  }, 2000);
  timer.unref?.();
  return () => clearInterval(timer);
}

async function probe(conn, watchConn, threadId, label, sql, { ms = PROBE_MS, show } = {}) {
  const seen = [];
  const stop = watchConn && threadId ? watchThread(watchConn, threadId, seen) : () => {};
  const t = Date.now();
  try {
    const [rows] = await conn.query({ sql, timeout: ms });
    stop();
    const took = Date.now() - t;
    const n = Array.isArray(rows) ? rows.length : 0;
    console.log(`    ${label.padEnd(32)}ok    ${String(took).padStart(6)}ms  ${n} row(s)`);
    seen.forEach(l => console.log(l));
    if (show) show(rows);
    return { ok: true, took, rows };
  } catch (e) {
    stop();
    const took = Date.now() - t;
    console.log(`    ${label.padEnd(32)}FAIL  ${String(took).padStart(6)}ms  ${e.code || ''} ${e.message}`);
    seen.forEach(l => console.log(l));
    return { ok: false, took };
  }
}

(async () => {
  console.log(`\n=== TPMS doctor ===`);
  console.log(`target        : ${cfg.user}@${cfg.host}:${cfg.port}/${cfg.database}`);
  console.log(`app timeout   : TPMS_QUERY_TIMEOUT_MS=${APP_TIMEOUT}ms`);
  console.log(`probe timeout : ${PROBE_MS}ms each\n`);

  const tcp = await tcpProbe(cfg.host, cfg.port);
  console.log(tcp.ok ? `[1] TCP connect            ok (${tcp.ms}ms)`
                     : `[1] TCP connect            FAILED after ${tcp.ms}ms — ${tcp.why}`);
  if (!tcp.ok) {
    console.log(`\n→ The container cannot reach the TPMS host: network/firewall, not the app.\n`);
    process.exit(1);
  }

  let conn, watchConn;
  let t = Date.now();
  try {
    conn = await mysql.createConnection(cfg);
    console.log(`[2] MySQL handshake        ok (${Date.now() - t}ms)`);
  } catch (e) {
    console.log(`[2] MySQL handshake        FAILED after ${Date.now() - t}ms — ${e.code || ''} ${e.message}`);
    console.log(`\n→ TCP works, login does not. Check MYSQL_USER / MYSQL_PASSWORD and that the`);
    console.log(`  account may connect from this container's address.\n`);
    process.exit(1);
  }

  // Second connection purely to observe the first one's thread.
  let threadId = null;
  try {
    const [[row]] = await conn.query('SELECT CONNECTION_ID() AS id');
    threadId = row.id;
    watchConn = await mysql.createConnection(cfg);
  } catch { /* observation is optional */ }

  console.log(`[3] the view`);
  await probe(conn, null, null, 'SHOW CREATE VIEW', `SHOW CREATE VIEW ${VIEW}`, {
    ms: 10000,
    show: rows => {
      const def = rows?.[0]?.['Create View'] || '';
      const body = def.replace(/^.*?\bAS\b\s*/is, '').replace(/\s+/g, ' ');
      const joins = (body.match(/\bjoin\b/gi) || []).length;
      const subq  = (body.match(/\bselect\b/gi) || []).length - 1;
      const algo  = /ALGORITHM\s*=\s*(\w+)/i.exec(def)?.[1] || 'UNDEFINED';
      console.log(`         algorithm=${algo}  joins=${joins}  subselects=${subq}  length=${body.length} chars`);
      console.log(`         ${body.slice(0, 600)}${body.length > 600 ? ' …' : ''}`);
    },
  });

  console.log(`[4] timing ladder`);
  const count  = await probe(conn, watchConn, threadId, 'COUNT(*) over the view', `SELECT COUNT(*) AS n FROM ${VIEW}`, {
    show: rows => console.log(`         ${rows[0].n} rows in the view`),
  });
  const one    = await probe(conn, watchConn, threadId, 'first row only (LIMIT 1)', `${AS_CSHARP} LIMIT 1`);
  const csharp = await probe(conn, watchConn, threadId, "C# shape (no ORDER BY)", AS_CSHARP);
  const nosort = await probe(conn, watchConn, threadId, 'app shape, no ORDER BY', AS_APP_NO_SORT);
  const app    = await probe(conn, watchConn, threadId, 'app shape as shipped', AS_APP, { ms: Math.max(PROBE_MS, APP_TIMEOUT + 5000) });

  console.log(`[5] plan`);
  await probe(conn, null, null, 'EXPLAIN app shape', `EXPLAIN ${AS_APP}`, {
    ms: 10000,
    show: rows => rows.forEach(r =>
      console.log(`         ${String(r.select_type || '').padEnd(12)} ${String(r.table || '').padEnd(24)} ` +
                  `type=${String(r.type || '-').padEnd(8)} rows=${String(r.rows ?? '-').padStart(8)} ${r.Extra || ''}`)),
  });

  // ---- verdict -------------------------------------------------------------
  console.log(`\n=== verdict ===`);
  if (app.ok && app.took < 1000) {
    console.log(`The query is fast (${app.took}ms) on a connection opened just now. The DB is`);
    console.log(`not the problem — the app was being handed a bad pooled socket.`);
  } else if (!count.ok || count.took > 5000) {
    console.log(`Materialising the view is itself slow (COUNT(*) ${count.ok ? count.took + 'ms' : 'did not finish'}).`);
    console.log(`No rewrite of the SELECT will help much: the cost is inside ${VIEW}.`);
    console.log(`Look at the EXPLAIN above for the base table with the largest "rows" and no`);
    console.log(`index (type=ALL), and at the thread states printed during the ladder.`);
  } else if (app.ok && nosort.ok && app.took > nosort.took * 2) {
    console.log(`The view is fine; the ORDER BY is the cost (${nosort.took}ms → ${app.took}ms).`);
    console.log(`The C# does not sort at all. Drop ORDER BY Project_Name from SQL.projectList`);
    console.log(`and sort the ${count.rows?.[0]?.n ?? 'few hundred'} rows in Node instead.`);
  } else if (csharp.ok && !app.ok) {
    console.log(`The C# shape completes (${csharp.took}ms) but the app's does not. The extra`);
    console.log(`COALESCE/CONCAT/ORDER BY is what tips it over. Select the plain columns and`);
    console.log(`build "text" in Node.`);
  } else {
    console.log(`Nothing completed within ${PROBE_MS}ms. Check the thread states printed above:`);
    console.log(`"Waiting for table metadata lock" means something else holds the base tables;`);
    console.log(`"Sending data"/"Copying to tmp table" means the view is genuinely this slow.`);
  }
  console.log('');

  await conn.end().catch(() => {});
  await watchConn?.end().catch(() => {});
  process.exit(0);
})().catch(e => { console.error('doctor failed:', e); process.exit(1); });
