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
const DEFAULT_TECHSERVER_MCP_URL = 'http://techserver-mcp:8053';

// Where EPLAN says it put the drawing.
//
// AsyncTcpServer answers with ProjectService's return value: the project path
// prefixed by the generation type — "sld<path>", "old<path>", or for both at
// once "sldold<sldPath>&*<oldPath>". Each path starts with the EPLAN variable
// $(MD_Projects), which is the techserver root, so what follows is
// "\OE12112\Drawing\MV\Single line\...\ASLD.elk": the OE share, then the
// path inside it. Eplanix's own FinishJob view parses the identical string to
// build its download links, including appending .elk when it is missing.
//
// techserver-mcp addresses files as (oenum, path-within-share), which is why
// the two are split apart here rather than passed on as one string.
const MD_PROJECTS = '$(MD_Projects)';

function parseEplanProjects(raw) {
  const status = String(raw || '').trim();
  if (!status || status.toLowerCase().startsWith('error')) return [];

  let parts;
  if (status.startsWith('sldold')) {
    parts = status.slice(6).split('&*').filter(Boolean)
      .map((p, i) => ({ raw: p, type: i === 0 ? 'sld' : 'old' }));
  } else if (status.startsWith('sld')) {
    parts = [{ raw: status.slice(3), type: 'sld' }];
  } else if (status.startsWith('old')) {
    parts = [{ raw: status.slice(3), type: 'old' }];
  } else {
    return [];
  }

  return parts.map(({ raw: p, type }) => {
    let rest = p.trim();
    if (rest.startsWith(MD_PROJECTS)) rest = rest.slice(MD_PROJECTS.length);
    rest = rest.replace(/^[\\/]+/, '');
    if (!/\.elk$/i.test(rest)) rest += '.elk';

    const segments = rest.split(/[\\/]+/);
    const oenum = segments.shift() || '';
    return {
      type,
      displayName: type === 'sld' ? 'Singleline Project' : 'Outline Project',
      oenum,
      path: segments.join('/'),
      fileName: segments[segments.length - 1] || '',
    };
  }).filter(x => x.oenum && x.path);
}


function techserverConfig() {
  return {
    url: String(process.env.TECHSERVER_MCP_URL || DEFAULT_TECHSERVER_MCP_URL).replace(/\/$/, ''),
    timeoutMs: Number(process.env.EPLAN_DOWNLOAD_TIMEOUT_MS) || 900000,
  };
}

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

      // The download buttons need an address, not the sentence the bridge
      // composes for the status line — so the raw path is parsed into the
      // project(s) EPLAN wrote, each one already split into the OE share and
      // the path inside it that techserver-mcp wants.
      const projects = parseEplanProjects(parsed.project_path);

      return res.json({
        success: true,
        records: data.length,
        status: parsed.status || 'completed',
        jobId: parsed.job_id,
        message: parsed.message || `${data.length} record(s) sent to EPLAN.`,
        projects,
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

  // ── Downloading what EPLAN produced ──────────────────────────────────────
  //
  // The drawings land on the techserver SMB share, which this backend has no
  // credentials for and no SMB client in. techserver-mcp already holds both —
  // it reads that same host for the RAG side — so the bytes are streamed
  // through from there rather than duplicating any of it here.
  //
  // Streamed, not buffered: an EPLAN project zip is routinely hundreds of
  // megabytes, and reading one into memory to hand it on would be the largest
  // allocation this process ever makes, once per click.
  const download = (route, endpoint, what) => {
    app.get(route, async (req, res) => {
      const { oenum, path: projectPath } = req.query;
      if (!oenum || !projectPath) {
        return res.status(400).json({
          success: false,
          error: 'oenum and path are both required — they come from the send response.',
        });
      }

      const { url, timeoutMs } = techserverConfig();
      const target = `${url}${endpoint}?oenum=${encodeURIComponent(oenum)}`
                   + `&path=${encodeURIComponent(projectPath)}`;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const upstream = await fetch(target, { signal: controller.signal });

        if (!upstream.ok) {
          const detail = await upstream.text().catch(() => '');
          let parsed; try { parsed = JSON.parse(detail); } catch { parsed = null; }
          return res.status(upstream.status).json({
            success: false,
            error: parsed?.detail || `Could not fetch the ${what} (${upstream.status}).`,
          });
        }

        for (const header of ['content-type', 'content-disposition', 'content-length']) {
          const value = upstream.headers.get(header);
          if (value) res.setHeader(header, value);
        }
        // Node's fetch gives a web ReadableStream; Readable.fromWeb bridges it
        // onto the response without collecting it first.
        const { Readable } = await import('node:stream');
        await new Promise((resolve, reject) => {
          const body = Readable.fromWeb(upstream.body);
          body.on('error', reject);
          res.on('finish', resolve);
          res.on('close', resolve);
          body.pipe(res);
        });
      } catch (err) {
        const timedOut = err.name === 'AbortError';
        // Headers are already out once streaming starts; destroying is all
        // that is left, and it surfaces to the browser as a failed download
        // rather than a silently truncated file.
        if (res.headersSent) return res.destroy(err);
        return res.status(504).json({
          success: false,
          error: timedOut
            ? `Timed out fetching the ${what} (${Math.round(timeoutMs / 1000)}s).`
            : `Could not fetch the ${what}: ${err.message}`,
        });
      } finally {
        clearTimeout(timer);
      }
    });
  };

  download('/api/eplan/pdf', '/eplan/pdf', 'PDF');
  download('/api/eplan/zip', '/eplan/zip', 'project archive');
}
