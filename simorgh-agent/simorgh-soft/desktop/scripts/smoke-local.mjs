// Smoke test of the local suite as the installer carries it (bundle/), run on
// the Windows build machine before the installer is made:
//
//   1. the bundled mongod starts;
//   2. an Access parts file is written the way Settings writes one (Jet, via
//      writeAccessParts) — including a Persian description, to prove the text
//      survives the trip;
//   3. the bundled backend starts in local mode on it, serves the app under
//      /simorgh-design-suite/, answers the API there, and finds the parts.
//
// Exits non-zero on the first thing that does not hold.
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundle = path.resolve(here, '..', 'bundle');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'simorgh-smoke-'));
const children = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));

function fail(msg) {
  console.error(`✗ ${msg}`);
  for (const c of children) c.kill();
  process.exit(1);
}
function start(cmd, args, opts) {
  const c = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
  c.stdout.on('data', d => process.stdout.write(`[${path.basename(cmd)}] ${d}`));
  c.stderr.on('data', d => process.stdout.write(`[${path.basename(cmd)}] ${d}`));
  children.push(c);
  return c;
}
async function until(fn, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (await fn()) return; } catch { /* not yet */ }
    await sleep(500);
  }
  fail(`${what} did not come up in ${ms / 1000}s`);
}

// 1. MongoDB
const mongoPort = 27077;
fs.mkdirSync(path.join(tmp, 'db'));
start(path.join(bundle, 'mongo', 'mongod.exe'),
  ['--dbpath', path.join(tmp, 'db'), '--port', String(mongoPort), '--bind_ip', '127.0.0.1', '--quiet',
    '--wiredTigerCacheSizeGB', '0.25', '--setParameter', 'diagnosticDataCollectionEnabled=false']);
await until(async () => {
  const net = await import('net');
  return new Promise(res => {
    const s = net.connect(mongoPort, '127.0.0.1');
    s.once('connect', () => { s.destroy(); res(true); });
    s.once('error', () => res(false));
  });
}, 60000, 'mongod');
console.log('✓ mongod is up');

// 2. An Access parts file, written the way Settings writes one
const accessFile = path.join(tmp, 'parts', 'EplanParts.mdb');
const { writeAccessParts } = await import(pathToFileURL(path.join(bundle, 'backend', 'localDesktop.js')).href);
await writeAccessParts([
  { partnr: 'SIE.3RT2015-1BB41', typenr: '3RT2015-1BB41', manufacturer: 'SIE', description1: 'Contactor, AC-3, 3 kW', width: 45, height: 57.5, depth: 73, weight: 0.24 },
  { partnr: 'SIE.3VA2110', typenr: '3VA2110-5HL32', manufacturer: 'SIE', description1: 'Circuit breaker "3VA2" 100 A', width: 76.2 },
  { partnr: 'ABB.OT16F3', typenr: 'OT16F3', manufacturer: 'ABB', description1: 'کلید قطع بار ۱۶ آمپر', description2: 'Switch-disconnector' },
], accessFile, step => console.log(`  ${step}`));
if (!fs.existsSync(accessFile)) fail('no Access file was written');
console.log(`✓ Access file written (${fs.statSync(accessFile).size} bytes)`);

// 3. The backend, in local mode, on that file
const port = 3977;
start(process.execPath, [path.join(bundle, 'backend', 'server.js')], {
  cwd: path.join(bundle, 'backend'),
  env: {
    ...process.env,
    PORT: String(port), HOST: '127.0.0.1',
    MONGODB_URI: `mongodb://127.0.0.1:${mongoPort}`,
    STATIC_DIR: path.join(bundle, 'frontend'), BASE_PATH: '/simorgh-design-suite/',
    SIMORGH_LOCAL: '1', PARTS_SOURCE: 'access', PARTS_ACCESS_FILE: accessFile,
  },
});
const base = `http://127.0.0.1:${port}/simorgh-design-suite/`;
await until(async () => (await fetch(base)).ok, 60000, 'the backend');

const html = await (await fetch(base)).text();
if (!html.includes('id="root"')) fail('the app page is not served under /simorgh-design-suite/');
console.log('✓ the app is served');

const deep = await fetch(base + 'some/client/route');
if (!(await deep.text()).includes('id="root"')) fail('client routes do not fall back to the app');

const projects = await fetch(base + 'api/projects');
if (!projects.ok) fail(`api/projects answered ${projects.status}`);
console.log('✓ the API answers under the base path');

const parts = await (await fetch(base + 'api/parts?search=3rt')).json();
if (!parts.success || parts.total !== 1 || parts.data[0].partnr !== 'SIE.3RT2015-1BB41') fail(`parts search: ${JSON.stringify(parts)}`);
const all = await (await fetch(base + 'api/eplan-parts', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ manufacturer: 'ABB' }),
})).json();
if (!all.success || all.total !== 1 || all.data[0].Designation1 !== 'کلید قطع بار ۱۶ آمپر') fail(`eplan-parts: ${JSON.stringify(all)}`);
if (all.manufacturers.join() !== 'ABB,SIE') fail(`manufacturers: ${all.manufacturers}`);
console.log('✓ parts come from the Access file, Persian text intact');

const test = await (await fetch(base + 'api/local/test/access', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file: accessFile }),
})).json();
if (!test.ok) fail(`test/access: ${test.message}`);
console.log(`✓ ${test.message}`);

for (const c of children) c.kill();
console.log('All good.');
process.exit(0);
