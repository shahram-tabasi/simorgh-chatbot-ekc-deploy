// Sending a project to EPLAN.
//
// The actual EPLAN listener (AsyncTcpServer, in the Eplanix add-in) binds
// 127.0.0.1 on the EPLAN machine — Eplanix's own MVC app gets away with
// that because it runs on that same machine. This backend runs on a
// different server, so it never talks to that socket directly: it posts to
// eplan-bridge-service (see simorgh-agent/eplan-bridge-service), the
// HTTP-to-TCP bridge already running in this stack's compose network,
// which does the length-prefixed TCP framing and the pool bookkeeping
// (auto-picking one of the ports Eplanix's own TcpPortResolverService hands
// out from, so nothing here has to know or guess a port).
//
//   EPLAN_BRIDGE_URL       default: http://eplan-bridge:8026 (the compose
//                          service name — works as-is inside the stack)
//   EPLAN_BRIDGE_API_KEY   sent as X-API-Key, if the bridge was deployed
//                          with one set
//   EPLAN_BRIDGE_TIMEOUT_MS
//
// See simorgh-agent/docs/EPLAN_SEND.md for the whole path, including how
// the bridge itself reaches EPLAN across servers (eplan-port-forwarder).

const DEFAULT_BRIDGE_URL = 'http://eplan-bridge:8026';

function bridgeConfig() {
  const url = String(process.env.EPLAN_BRIDGE_URL || DEFAULT_BRIDGE_URL).replace(/\/$/, '');
  return {
    url,
    apiKey: process.env.EPLAN_BRIDGE_API_KEY || '',
    timeoutMs: Number(process.env.EPLAN_BRIDGE_TIMEOUT_MS) || 120000,
  };
}

function bridgeHeaders(apiKey) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['X-API-Key'] = apiKey;
  return headers;
}

async function callBridge(path, { method = 'GET', body, apiKey, timeoutMs } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(path, {
      method,
      headers: bridgeHeaders(apiKey),
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const raw = await response.text();
    let parsed;
    try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = { detail: raw.slice(0, 500) }; }
    return { ok: response.ok, status: response.status, body: parsed };
  } finally {
    clearTimeout(timer);
  }
}

export function registerEplanRoutes(app) {
  // Where the app would send, and whether an API key is configured — the
  // dialog shows this, there is nothing left for the user to pick.
  app.get('/api/eplan/target', (req, res) => {
    const { url, apiKey } = bridgeConfig();
    res.json({ url, authenticated: !!apiKey });
  });

  // Is an EPLAN instance currently available to draw with? Asks the
  // bridge's own pool check rather than opening a socket from here — this
  // backend never holds one itself.
  app.post('/api/eplan/ping', async (req, res) => {
    const { url, apiKey } = bridgeConfig();
    try {
      const result = await callBridge(`${url}/port/resolve`, {
        method: 'POST', body: { username: req.body?.userName || 'simorgh' }, apiKey, timeoutMs: 10000,
      });
      if (result.ok) {
        return res.json({ reachable: true, target: `${result.body.host}:${result.body.port}` });
      }
      return res.json({ reachable: false, error: result.body.detail || `bridge answered ${result.status}` });
    } catch (err) {
      const timedOut = err.name === 'AbortError';
      return res.json({
        reachable: false,
        error: timedOut ? 'Timed out waiting for the EPLAN bridge.' : `Could not reach the EPLAN bridge: ${err.message}`,
      });
    }
  });

  // The records themselves.
  app.post('/api/eplan/send', async (req, res) => {
    const { projectName, data, userName } = req.body || {};

    if (!Array.isArray(data) || data.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Nothing to send — the request carried no EplanData records.',
      });
    }

    const { url, apiKey, timeoutMs } = bridgeConfig();
    const body = {
      project_name: projectName || data[0]?.ProjectName || 'project',
      username: userName || data[0]?.UserName || 'simorgh',
      eplan_data: data,
      // No `port`: the bridge auto-picks one from the pool, the same way
      // TcpPortResolverService does for Eplanix's own interactive users.
    };

    try {
      const result = await callBridge(`${url}/draw`, { method: 'POST', body, apiKey, timeoutMs });
      const parsed = result.body;

      if (!result.ok || parsed.status === 'failed') {
        return res.status(result.ok ? 502 : result.status).json({
          success: false,
          error: parsed.detail || parsed.message || parsed.error || `The EPLAN bridge answered ${result.status}.`,
        });
      }

      return res.json({
        success: true,
        records: data.length,
        status: parsed.status || 'completed',
        jobId: parsed.job_id,
        message: parsed.message || `${data.length} record(s) sent to EPLAN.`,
      });
    } catch (err) {
      const timedOut = err.name === 'AbortError';
      return res.status(504).json({
        success: false,
        error: timedOut
          ? `Timed out waiting for the EPLAN bridge (${Math.round(timeoutMs / 1000)}s).`
          : `Could not reach the EPLAN bridge at ${url}: ${err.message}`,
      });
    }
  });
}
