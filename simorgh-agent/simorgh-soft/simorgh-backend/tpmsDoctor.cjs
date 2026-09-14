#!/usr/bin/env node
/**
 * tpmsDoctor — why is /api/tpms/* timing out?
 *
 * A "Query inactivity timeout" tells you the query never answered, but not
 * why. There are three quite different causes and they need different fixes:
 *
 *   1. the socket is dead        — the network path drops idle flows
 *   2. the server is blocked     — the query waits on a lock
 *   3. the view is genuinely slow — it really does take longer than the timeout
 *
 * This opens its own fresh connection, so it sees none of the app's pooled
 * sockets. Read it against the app's behaviour:
 *
 *   app fails, doctor passes quickly  → (1), stale pooled socket
 *   both hang, other queries fine     → (2), check the blocked-thread list
 *   both slow by the same amount      → (3), the view needs work or more time
 *
 * CommonJS (.cjs) on purpose: the backend is ESM, and this has to run as a
 * one-off inside the container without tripping over that.
 *
 * Run:  docker compose cp <this file> simorgh-soft:/tmp/tpmsDoctor.cjs
 *       docker compose exec simorgh-soft node /tmp/tpmsDoctor.cjs
 */
const net = require('net');

// Resolved from /app, not from wherever this file was dropped.
const mysql = require('/app/node_modules/mysql2/promise');

const cfg = {
  host: process.env.MYSQL_HOST || '192.168.1.148',
  port: parseInt(process.env.MYSQL_PORT, 10) || 3306,
  user: process.env.MYSQL_USER || 'technical',
  password: process.env.MYSQL_PASSWORD || 'HoJETA',
  database: process.env.MYSQL_DATABASE || 'TPMS',
  connectTimeout: 15000,
};

// Character for character what /api/tpms/projects runs.
const PROJECT_LIST = `
  SELECT IDProjectMain AS value,
         COALESCE(OENUM, '') AS code,
         COALESCE(Project_Name, '') AS name,
         CONCAT(COALESCE(OENUM, ''), ' ', COALESCE(Project_Name, '')) AS text
  FROM View_Project_Main
  ORDER BY Project_Name`;

const APP_TIMEOUT = Number(process.env.TPMS_QUERY_TIMEOUT_MS || 60000);
const since = t => `${Date.now() - t}ms`;

/** Can we even open a TCP socket? Separates "network" from "MySQL". */
function tcpProbe(host, port, ms = 10000) {
  return new Promise(resolve => {
    const started = Date.now();
    const sock = new net.Socket();
    const done = outcome => {
      sock.destroy();
      resolve({ ...outcome, ms: Date.now() - started });
    };
    sock.setTimeout(ms);
    sock.once('connect', () => done({ ok: true }));
    sock.once('timeout', () => done({ ok: false, why: 'no SYN-ACK (silently dropped — firewall or wrong route)' }));
    sock.once('error', e => done({ ok: false, why: `${e.code || e.message}` }));
    sock.connect(port, host);
  });
}

(async () => {
  console.log(`\n=== TPMS doctor ===`);
  console.log(`target : ${cfg.user}@${cfg.host}:${cfg.port}/${cfg.database}`);
  console.log(`app gives up after TPMS_QUERY_TIMEOUT_MS=${APP_TIMEOUT}ms\n`);

  const tcp = await tcpProbe(cfg.host, cfg.port);
  console.log(tcp.ok
    ? `[1] TCP connect            ok (${tcp.ms})`
    : `[1] TCP connect            FAILED after ${tcp.ms} — ${tcp.why}`);
  if (!tcp.ok) {
    console.log(`\n→ The container cannot reach the TPMS host. This is a network/firewall`);
    console.log(`  problem, not an application one. Nothing in the backend can fix it.`);
    process.exit(1);
  }

  let conn;
  let t = Date.now();
  try {
    conn = await mysql.createConnection(cfg);
    console.log(`[2] MySQL handshake        ok (${since(t)})`);
  } catch (e) {
    console.log(`[2] MySQL handshake        FAILED after ${since(t)} — ${e.code || ''} ${e.message}`);
    console.log(`\n→ TCP works but MySQL refused the login. Check MYSQL_USER / MYSQL_PASSWORD`);
    console.log(`  and that the account is allowed to connect from this container's IP.`);
    process.exit(1);
  }

  t = Date.now();
  await conn.query({ sql: 'SELECT 1', timeout: 15000 });
  console.log(`[3] SELECT 1               ok (${since(t)})`);

  // Anything already stuck server-side? Needs PROCESS privilege; not fatal.
  try {
    const [threads] = await conn.query({ sql: 'SHOW FULL PROCESSLIST', timeout: 15000 });
    const stuck = threads.filter(p => p.Command === 'Query' && Number(p.Time) > 5);
    console.log(`[4] server threads         ${threads.length} total, ${stuck.length} running a query >5s`);
    for (const p of stuck.slice(0, 8)) {
      console.log(`      #${p.Id}  ${p.Time}s  ${p.State || '-'}  ${String(p.Info || '').replace(/\s+/g, ' ').slice(0, 100)}`);
    }
    if (stuck.length) {
      console.log(`    → queries piling up like this is cause (2): something is holding a lock.`);
    }
  } catch (e) {
    console.log(`[4] server threads         skipped (${e.code || e.message})`);
  }

  // The real thing. Given room to finish so we learn how long it actually takes.
  t = Date.now();
  try {
    const [rows] = await conn.query({ sql: PROJECT_LIST, timeout: Math.max(APP_TIMEOUT * 3, 180000) });
    const took = Date.now() - t;
    console.log(`[5] View_Project_Main      ${rows.length} rows in ${took}ms`);
    if (took > APP_TIMEOUT) {
      console.log(`\n→ Cause (3): the view is slower than the app's ${APP_TIMEOUT}ms budget on a`);
      console.log(`  healthy connection. Raise TPMS_QUERY_TIMEOUT_MS, or drop the ORDER BY`);
      console.log(`  (the C# does not sort) and sort the few hundred rows in Node instead.`);
    } else {
      console.log(`\n→ The query is fine (${took}ms) on a connection opened just now, yet the`);
      console.log(`  app times out at ${APP_TIMEOUT}ms. That is cause (1): the app is being`);
      console.log(`  handed a pooled socket that died while idle. The keepalive +`);
      console.log(`  ping-before-use change on this branch is the fix.`);
    }
  } catch (e) {
    console.log(`[5] View_Project_Main      FAILED after ${since(t)} — ${e.code || ''} ${e.message}`);
    console.log(`\n→ It fails on a brand-new connection too, so this is not the pool. Look at`);
    console.log(`  the thread list above, and at whether the view's base tables are locked.`);
  }

  await conn.end();
  console.log('');
})().catch(e => { console.error('doctor failed:', e); process.exit(1); });
