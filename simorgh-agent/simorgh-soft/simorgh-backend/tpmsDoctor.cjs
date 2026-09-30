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
    const ifs = fs.readdirSync('/sys/class/net').filter(n => n !== 'lo').sort()
      .map(n => { try { return { n, mtu: Number(fs.readFileSync(`/sys/class/net/${n}/mtu`, 'utf8').trim()) }; } catch { return null; } })
      .filter(Boolean);
    // eth0 is the bridge to app_net — the one whose MSS the server sees.
    const primary = ifs.find(i => i.n === 'eth0') || ifs[0];
    return { text: ifs.map(i => `${i.n}=${i.mtu}`).join('  '), primary: primary?.mtu || 1500, name: primary?.n || 'eth0' };
  } catch { return { text: 'unavailable', primary: 1500, name: 'eth0' }; }
}
const MTU = localMtus();

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
  console.log(`local MTU   : ${MTU.text}\n`);

  const tcp = await tcpProbe(cfg.host, cfg.port);
  console.log(tcp.ok ? `[1] TCP connect            ok (${tcp.ms}ms)`
                     : `[1] TCP connect            FAILED (${tcp.ms}ms) — ${tcp.why}`);
  if (!tcp.ok) { console.log(`\n→ Network/firewall, not the app.\n`); process.exit(1); }

  const box = connBox(() => mysql.createConnection(cfg));
  const t0 = Date.now();
  try { await box.get(); console.log(`[2] MySQL handshake        ok (${Date.now() - t0}ms)`); }
  catch (e) { console.log(`[2] MySQL handshake        FAILED — ${e.code || ''} ${e.message}\n`); process.exit(1); }

  // ---- inbound: how many bytes can reach us? -----------------------------
  // One row, one column, of a size we choose. Nothing to do with the view,
  // indexes or sorting: purely "how many bytes can come back".
  //
  // For SELECT REPEAT('x', n) the server writes about n + 84 bytes (column
  // count, column definition, the row itself, EOF). The first TCP segment of
  // that is full-size, so the reply fails as soon as n + 84 exceeds the MSS
  // the path can actually carry — which makes the cutoff a direct measure of
  // the path MTU, give or take the 40 bytes of TCP/IP header.
  const PAYLOAD_OVERHEAD = 84, TCPIP = 40;
  const ask = (n, ms = 5000) => probe(box, `payload ${n}`, `SELECT REPEAT('x', ${n}) AS p`, { ms, quiet: true });

  console.log(`[3] inbound — how many bytes can the server send us?`);
  let lastOk = 0, firstBad = null;
  for (const n of [256, 512, 1024, 1300, 1400, 1460, 1500, 2000, 8192, 65536]) {
    const r = await ask(n);
    console.log(`    ${String(n).padStart(7)} bytes   ${r.ok ? `ok   ${String(r.took).padStart(5)}ms` : `FAIL ${String(r.took ?? 0).padStart(5)}ms  never arrived`}`);
    if (r.ok) lastOk = n; else { firstBad = n; break; }
  }

  // Narrow the boundary, so the MTU to configure is a measurement rather than
  // a guess. Stops at 8 bytes: finer than that buys nothing.
  if (firstBad) {
    console.log(`    narrowing between ${lastOk} and ${firstBad}…`);
    let lo = lastOk, hi = firstBad;
    while (hi - lo > 8) {
      const mid = Math.floor((lo + hi) / 2);
      const r = await ask(mid);
      console.log(`    ${String(mid).padStart(7)} bytes   ${r.ok ? 'ok' : 'FAIL'}`);
      if (r.ok) lo = mid; else hi = mid;
    }
    lastOk = lo; firstBad = hi;
  }

  // ---- outbound: can we send large packets? -------------------------------
  // A big statement with a tiny reply. If this succeeds while the inbound test
  // fails, only one direction is broken, which narrows down which device.
  console.log(`[4] outbound — can we send the server large packets?`);
  let outboundOk = true;
  for (const n of [2000, 8192, 65536]) {
    const r = await probe(box, `send ${n}`, `SELECT LENGTH('${'x'.repeat(n)}') AS n`, { ms: 5000, quiet: true });
    console.log(`    ${String(n).padStart(7)} bytes   ${r.ok ? `ok   ${String(r.took).padStart(5)}ms` : `FAIL ${String(r.took ?? 0).padStart(5)}ms  never delivered`}`);
    if (!r.ok) { outboundOk = false; break; }
  }

  // ---- correlate with the real thing --------------------------------------
  console.log(`[5] the real query, by size`);
  let lastGoodRows = 0;
  for (const lim of [1, 10, 50, 100, 500, 1756]) {
    const r = await probe(box, `LIMIT ${lim}`, `${AS_CSHARP} LIMIT ${lim}`, { ms: 6000, quiet: true });
    console.log(`    ${String(lim).padStart(7)} rows    ${r.ok ? `ok   ${String(r.took).padStart(5)}ms` : `FAIL ${String(r.took ?? 0).padStart(5)}ms  never arrived`}`);
    if (r.ok) lastGoodRows = lim; else break;
  }
  const app = await probe(box, 'app shape as shipped', AS_APP, { ms: Math.min(APP_TIMEOUT, 15000) });

  // ---- verdict -------------------------------------------------------------
  console.log(`\n=== verdict ===`);
  if (firstBad && lastOk) {
    const mss  = lastOk + PAYLOAD_OVERHEAD;      // largest reply that got through
    const pmtu = mss + TCPIP;                    // ...as an IP packet
    const safe = Math.max(1280, Math.floor(pmtu / 20) * 20 - 20);
    console.log(`Replies of ${lastOk} bytes arrive in milliseconds; ${firstBad} bytes never arrive at all.`);
    console.log(`The server is not slow — it answers a small question instantly and a large`);
    console.log(`one not at all. Nothing about the view, the sort or the row count matters;`);
    console.log(`only the size of the answer does.`);
    console.log(``);
    console.log(`That is a path-MTU black hole between this container and ${cfg.host}. This`);
    console.log(`container advertises an MSS of ${MTU.primary - TCPIP} (${MTU.name} MTU ${MTU.primary}), so the server sends`);
    console.log(`full-size segments; something in the path cannot carry them and drops them,`);
    console.log(`and the ICMP "fragmentation needed" that would tell TCP to send less is being`);
    console.log(`dropped too, so it retransmits the same oversized segment until the client`);
    console.log(`gives up. Largest reply that survives: ~${mss} bytes of TCP payload, so the real`);
    console.log(`path MTU is about ${pmtu} bytes.`);
    console.log(``);
    console.log(`It is NOT an IP block or a MySQL limit: the handshake, SELECT 1, COUNT(*) and`);
    console.log(`${lastGoodRows} rows of the real query all succeed on this same connection. A block`);
    console.log(`would refuse the connection; max_allowed_packet would return an error, not`);
    console.log(`silence. ${outboundOk ? 'Large packets we send arrive fine, so only the\n   server-to-container direction is affected.' : 'Large packets we send do not arrive\n   either, so both directions are affected.'}`);
    console.log(``);
    console.log(`Fix it in the network, not the query. On app_net in simorgh-agent/compose:`);
    console.log(``);
    console.log(`  networks:`);
    console.log(`    app_net:`);
    console.log(`      name: simorgh_app_net`);
    console.log(`      driver: bridge`);
    console.log(`      driver_opts:`);
    console.log(`        com.docker.network.driver.mtu: "${safe}"`);
    console.log(``);
    console.log(`A lower MTU makes this container advertise a smaller MSS in its SYN, which is`);
    console.log(`what stops the server sending segments the path cannot carry. The network has`);
    console.log(`to be recreated for it to take effect (docker compose down && up -d), since`);
    console.log(`driver options are fixed when the network is created.`);
    console.log(``);
    console.log(`The durable fix belongs to whoever owns the path: stop dropping ICMP type 3`);
    console.log(`code 4, or clamp MSS to PMTU on the device in between.`);
  } else if (app.ok) {
    console.log(`Everything completed, the app's own query included (${app.took}ms). Whatever was`);
    console.log(`wrong is not reproducing right now — re-run this while the picker fails.`);
  } else {
    console.log(`Replies of every size arrived, yet the real query did not, so payload size is`);
    console.log(`not the variable after all. Re-check the server-side thread state.`);
  }
  console.log('');
  await box.reset();
  process.exit(0);
})().catch(e => { console.error('doctor failed:', e); process.exit(1); });
