// Sending a project to the EPLAN server.
//
// The EPLAN machine sits on one IP and one port on the office network. The
// browser never talks to it: the app posts here, and this forwards the
// records on. The address lives in .env —
//
//   EPLAN_API_HOST=192.168.1.39      the EPLAN machine
//   EPLAN_API_PORT=8000              the port it listens on
//   EPLAN_API_PATH=/draw             the endpoint that takes the records
//
// — so pointing the app at another machine or another port is an edit to
// .env and a restart of this service, with no frontend rebuild. The request
// may also carry `host` / `port`, which is what the Target fields in the
// Eplanix tab send; they override the .env values for that one call.
import net from 'net';

const DEFAULTS = {
  host: '127.0.0.1',
  port: 8000,
  path: '/draw',
  timeoutMs: 120000,
};

export function eplanTarget(override = {}) {
  const envHost = process.env.EPLAN_API_HOST;
  const envPort = process.env.EPLAN_API_PORT;
  const host = String(override.host || envHost || DEFAULTS.host).trim();
  const port = Number(override.port || envPort || DEFAULTS.port);
  let path = String(process.env.EPLAN_API_PATH || DEFAULTS.path).trim();
  if (!path.startsWith('/')) path = `/${path}`;
  return {
    host,
    port,
    path,
    url: `http://${host}:${port}${path}`,
    // "Configured" means somebody actually set the address, rather than the
    // service falling back to localhost.
    configured: !!(override.host || envHost) && !!(override.port || envPort),
    timeoutMs: Number(process.env.EPLAN_API_TIMEOUT_MS || DEFAULTS.timeoutMs),
  };
}

// A plain TCP connect: enough to say whether anything is listening on that
// address, without sending a project at it.
function probe(host, port, timeoutMs = 3000) {
  return new Promise(resolve => {
    const socket = new net.Socket();
    const done = (reachable, error) => {
      socket.destroy();
      resolve({ reachable, error });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false, `no answer from ${host}:${port} within ${timeoutMs}ms`));
    socket.once('error', err => done(false, err.message));
    socket.connect(port, host);
  });
}

export function registerEplanRoutes(app) {
  // Where the app would send, so the dialog can show it before anything is sent.
  app.get('/api/eplan/target', (req, res) => {
    const { host, port, path, url, configured } = eplanTarget();
    res.json({ host, port, path, url, configured });
  });

  // Is the EPLAN server up? Used by the "Test" button next to the address.
  app.post('/api/eplan/ping', async (req, res) => {
    const target = eplanTarget(req.body || {});
    const { reachable, error } = await probe(target.host, target.port);
    res.json({ reachable, target: `${target.host}:${target.port}`, ...(error ? { error } : {}) });
  });

  // The records themselves.
  app.post('/api/eplan/send', async (req, res) => {
    const { projectName, data, userName, host, port } = req.body || {};

    if (!Array.isArray(data) || data.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Nothing to send — the request carried no EplanData records.',
      });
    }

    const target = eplanTarget({ host, port });
    if (!Number.isFinite(target.port) || target.port <= 0) {
      return res.status(400).json({
        success: false,
        error: `"${port ?? process.env.EPLAN_API_PORT}" is not a usable port. Set EPLAN_API_PORT in the backend .env.`,
      });
    }

    const body = JSON.stringify({
      project_name: projectName || data[0]?.ProjectName || 'project',
      username: userName || data[0]?.UserName || 'simorgh',
      port: target.port,
      eplan_data: data,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), target.timeoutMs);
    try {
      const upstream = await fetch(target.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      });
      const raw = await upstream.text();
      let parsed;
      try { parsed = JSON.parse(raw); } catch { parsed = { message: raw.slice(0, 2000) }; }

      if (!upstream.ok) {
        return res.status(502).json({
          success: false,
          target: target.url,
          error: `EPLAN server answered ${upstream.status}: ${parsed.detail || parsed.message || raw.slice(0, 300)}`,
        });
      }

      return res.json({
        success: true,
        target: target.url,
        records: data.length,
        status: parsed.status || 'sent',
        jobId: parsed.job_id,
        message: parsed.message || `${data.length} record(s) sent to EPLAN.`,
        response: parsed,
      });
    } catch (err) {
      // Node's fetch reports a refused connection as a bare "fetch failed";
      // the cause underneath it is what actually says why.
      const cause = err.cause?.code || err.cause?.message;
      const reason = err.name === 'AbortError'
        ? `no answer within ${Math.round(target.timeoutMs / 1000)}s`
        : [err.message, cause].filter(Boolean).join(': ');
      return res.status(502).json({
        success: false,
        target: target.url,
        error: `Could not reach the EPLAN server at ${target.url} — ${reason}.`,
      });
    } finally {
      clearTimeout(timer);
    }
  });
}
