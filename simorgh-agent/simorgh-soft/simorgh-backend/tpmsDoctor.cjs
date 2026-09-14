#!/usr/bin/env node
/**
 * tpmsDoctor — why is /api/tpms/* timing out?
 *
 * What the earlier runs established, against the real database:
 *
 *   TCP 4ms, handshake 20ms, SELECT 1 5ms   the path and the login are fine
 *   View_Project_Main is `select … from PROJECT_MAIN`, no joins, 1756 rows
 *   COUNT(*) 3ms, LIMIT 1 2ms               the view is trivial and tiny
 *   all 1756 rows                           hangs, server thread state empty
 *
 * A server thread sitting at state '-' is a thread that is *not working*: it
 * has written its result out and moved on. So the rows are not slow to
 * produce, they are failing to arrive — the bytes leave the server and never
 * reach the container. Small answers get through, large ones do not.
 *
 * That is the signature of a path-MTU black hole: something between the
 * container network and the TPMS host carries a smaller MTU than 1500, and
 * the ICMP "fragmentation needed" that would normally teach TCP to send
 * smaller segments is being dropped, so every full-size segment vanishes and
 * is retransmitted forever. Eplanix does not hit it because it runs on a
 * Windows box on the flat LAN, not from inside Docker.
 *
 * This build proves or disproves that directly: it asks the server for a
 * single row of a known size, growing, and finds the exact byte count where
 * the answer stops arriving. A clean cutoff a little under 1500 bytes is the
 * MTU. No cutoff, and the payload size is not the variable.
 *
 * Run:  docker compose cp simorgh-soft/simorgh-backend/tpmsDoctor.cjs \
 *         simorgh-soft:/tmp/tpmsDoctor.cjs
 *       docker compose exec simorgh-soft node /tmp/tpmsDoctor.cjs
 */
const net = require('net');
const fs = require('fs');
const mysql = require('/app/node_modules/mysql2/promise');

const cfg = {
  host: process.env.MYSQL_HOST || '192.168.1.148',
  port: parseInt(process.env.MYSQL_PORT, 10) || 3306,
  user: process.env.MYSQL_USER || 'technical',
  password: process.env.MYSQL_PASSWORD || 'HoJETA',
  database: process.env.MYSQL_DATABASE || 'TPMS',
  connectTimeout: 15000,
};

const APP_TIMEOUT = Number(process.env.TPMS_QUERY_TIMEOUT_MS || 60000);
// Short: a reply that is coming at all comes in milliseconds on this LAN.
const PROBE_MS = Number(process.env.DOCTOR_PROBE_MS || 8000);
const VIEW = 'View_Project_Main';

const AS_CSHARP = `SELECT IDProjectMain, OENUM, Project_Name FROM ${VIEW}`;
const AS_APP = `
  SELECT IDProjectMain AS value,
         COALESCE(OENUM, '') AS code,
         COALESCE(Project_Name, '') AS name,
         CONCAT(COALESCE(OENUM, ''), ' ', COALESCE(Project_Name, '')) AS text
  FROM ${VIEW}
  ORDER BY Project_Name`;

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

function localMtus() {
  try {
    return fs.readdirSync('/sys/class/net')
      .filter(n => n !== 'lo')
      .map(n => { try { return `${n}=${fs.readFileSync(`/sys/class/net/${n}/mtu`, 'utf8').trim()}`; } catch { return null; } })
      .filter(Boolean).join('  ');
  } catch { return 'unavailable'; }
}

/** A query timeout is fatal in mysql2 — the socket is out of step with the
 *  protocol and every later probe on it would fail for the wrong reason. So
 *  the connection is held in a box and replaced whenever that happens. */
function connBox(make) {
  let conn = null;
  return {
    async get() { return (conn ??= await make()); },
    async reset() { try { await conn?.destroy?.(); } catch {} conn = null; },
  };
}

async function probe(box, label, sql, { ms = PROBE_MS, show, quiet } = {}) {
  let conn;
  try { conn = await box.get(); }
  catch (e) { console.log(`    ${label.padEnd(30)}FAIL  reconnect: ${e.code || e.message}`); return { ok: false }; }
  const t = Date.now();
  try {
    const [rows] = await conn.query({ sql, timeout: ms });
    const took = Date.now() - t;
    const n = Array.isArray(rows) ? rows.length : 0;
    if (!quiet) console.log(`    ${label.padEnd(30)}ok    ${String(took).padStart(6)}ms  ${n} row(s)`);
    if (show) show(rows);
    return { ok: true, took, rows };
  } catch (e) {
    const took = Date.now() - t;
    if (!quiet) console.log(`    ${label.padEnd(30)}FAIL  ${String(took).padStart(6)}ms  ${e.code || ''} ${e.message}`);
    if (e && e.fatal) await box.reset();
    return { ok: false, took };
  }
}

(async () => {
  console.log(`\n=== TPMS doctor ===`);
  console.log(`target      : ${cfg.user}@${cfg.host}:${cfg.port}/${cfg.database}`);
  console.log(`app timeout : ${APP_TIMEOUT}ms   probe timeout: ${PROBE_MS}ms`);
  console.log(`local MTU   : ${localMtus()}\n`);

  const tcp = await tcpProbe(cfg.host, cfg.port);
  console.log(tcp.ok ? `[1] TCP connect            ok (${tcp.ms}ms)`
                     : `[1] TCP connect            FAILED (${tcp.ms}ms) — ${tcp.why}`);
  if (!tcp.ok) { console.log(`\n→ Network/firewall, not the app.\n`); process.exit(1); }

  const box = connBox(() => mysql.createConnection(cfg));
  const t0 = Date.now();
  try { await box.get(); console.log(`[2] MySQL handshake        ok (${Date.now() - t0}ms)`); }
  catch (e) { console.log(`[2] MySQL handshake        FAILED — ${e.code || ''} ${e.message}\n`); process.exit(1); }

  // ---- the decisive test ---------------------------------------------------
  // One row, one column, of a size we choose. Nothing to do with the view, the
  // schema, indexes or sorting: purely "how many bytes can come back".
  console.log(`[3] how many bytes can the server send us?`);
  const sizes = [256, 512, 1024, 1300, 1400, 1460, 1500, 2000, 4096, 16384, 65536, 262144];
  let lastOk = 0, firstBad = null;
  for (const n of sizes) {
    const r = await probe(box, `payload ${n} bytes`, `SELECT REPEAT('x', ${n}) AS p`, { ms: 6000, quiet: true });
    console.log(`    ${String(n).padStart(7)} bytes   ${r.ok ? `ok   ${String(r.took).padStart(5)}ms` : `FAIL ${String(r.took ?? 0).padStart(5)}ms  never arrived`}`);
    if (r.ok) lastOk = n; else { firstBad ??= n; break; }
  }

  // ---- correlate with the real thing --------------------------------------
  console.log(`[4] the real query, by size`);
  const rowResults = [];
  for (const lim of [1, 10, 50, 100, 500, 1756]) {
    const r = await probe(box, `LIMIT ${lim}`, `${AS_CSHARP} LIMIT ${lim}`, { ms: 6000, quiet: true });
    console.log(`    ${String(lim).padStart(7)} rows    ${r.ok ? `ok   ${String(r.took).padStart(5)}ms` : `FAIL ${String(r.took ?? 0).padStart(5)}ms  never arrived`}`);
    rowResults.push({ lim, ...r });
    if (!r.ok) break;
  }
  const app = await probe(box, 'app shape as shipped', AS_APP, { ms: Math.min(APP_TIMEOUT, 15000) });

  // ---- verdict -------------------------------------------------------------
  console.log(`\n=== verdict ===`);
  if (firstBad && lastOk) {
    console.log(`Replies up to ${lastOk} bytes arrive; ${firstBad} bytes never does. The server is`);
    console.log(`not slow — it answers a small question instantly and a large one not at all.`);
    console.log(``);
    console.log(`That is a path-MTU black hole between this container and ${cfg.host}:`);
    console.log(`something in the path takes a smaller MTU than the ${localMtus()} above, and the`);
    console.log(`ICMP that would tell TCP to shrink its segments is being dropped, so every`);
    console.log(`full-size segment is retransmitted forever. Small results fit in one segment`);
    console.log(`and get through; the ${rowResults.find(r => !r.ok)?.lim ?? 'full'}-row result does not.`);
    console.log(``);
    console.log(`Fix it in the network, not the query. Lower the MTU on the Docker network`);
    console.log(`that simorgh-soft is on (app_net) to just under the cutoff, e.g.`);
    console.log(``);
    console.log(`  networks:`);
    console.log(`    app_net:`);
    console.log(`      driver_opts:`);
    console.log(`        com.docker.network.driver.mtu: "${Math.max(576, lastOk <= 1400 ? 1400 : 1450)}"`);
    console.log(``);
    console.log(`Recreating the network is required for that to take effect. The durable fix`);
    console.log(`is to stop dropping ICMP type 3 code 4 on the path, or to clamp MSS to PMTU`);
    console.log(`on the host's forwarding rules.`);
  } else if (app.ok) {
    console.log(`Everything completed, including the app's own query (${app.took}ms). Whatever`);
    console.log(`was wrong is not reproducing right now — re-run this while the picker fails.`);
  } else {
    console.log(`Payload size is not the variable: replies of every size above arrived, yet the`);
    console.log(`real query still did not. Look again at the thread state and at whether the`);
    console.log(`failure tracks row count rather than bytes.`);
  }
  console.log('');
  await box.reset();
  process.exit(0);
})().catch(e => { console.error('doctor failed:', e); process.exit(1); });
