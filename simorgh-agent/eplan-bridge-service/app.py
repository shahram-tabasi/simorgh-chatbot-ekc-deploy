"""
EPLAN Drawing REST Bridge Service
====================================
REST API bridge to the EPLAN TCP server (AsyncTcpServer on the Eplanix
add-in — see eplanix/StartAction.epladdin.app1/TcpServer/AsyncTcpServer.cs).
Wraps the legacy length-prefixed TCP protocol with a modern HTTP interface
so this stack's services (and Simorgh's "Send to EPLAN") can trigger EPLAN
drawing generation without any of them holding a raw socket themselves.

Two-hop reachability
---------------------
AsyncTcpServer binds `127.0.0.1` only (see its C# constructor) — Eplanix's
own MVC app gets away with this because it runs on the *same* Windows box as
EPLAN. This bridge does not: it runs in this repo's Linux docker-compose
stack, on a different machine than EPLAN. So `EPLAN_HOST` here can never be
"the EPLAN machine's IP" directly — nothing is listening on that machine's
real interface, only on its loopback.

The second hop that makes this reachable is `eplan-port-forwarder` (see
../eplan-port-forwarder), a small byte-for-byte TCP relay deployed on the
EPLAN machine itself (via Docker Desktop, which is already used there) that
listens on the machine's real interface for the whole EPLAN port pool and
forwards each connection to that same port on `127.0.0.1`. Point `EPLAN_HOST`
at *that* relay's LAN address, not at EPLAN's own IP as if it spoke this
protocol directly — the forwarder is what makes the two the same thing.

This is deliberately not "bind AsyncTcpServer to 0.0.0.0" (that needs a code
change in the Eplanix repo, and would put an unauthenticated raw socket
straight on the network) and not a generic reverse proxy (the pool is a
range of 101 ports handed out dynamically — a single static upstream can't
follow that). A plain port-range relay, restricted by firewall to this
bridge's own address, keeps AsyncTcpServer exactly as Eplanix ships it.

Endpoints:
  POST /draw              - Send EplanData to generate drawings (auto-picks
                             a port from the pool when none is given)
  GET  /job/{job_id}      - Check job status
  POST /port/resolve      - Get an available EPLAN port
  GET  /health            - Health check
  /mcp                    - MCP Streamable HTTP endpoint
"""

import asyncio
import json
import logging
import os
import struct
import uuid
from datetime import datetime
from typing import Optional, Dict, Any, List

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field
from mcp.server.fastmcp import FastMCP

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="EPLAN Bridge Service", version="1.1.0")

# Where the *forwarder* on the EPLAN machine listens — see the module
# docstring. Not EPLAN's own IP unless something there also does that
# forwarding (it doesn't, out of the box).
EPLAN_HOST = os.getenv("EPLAN_HOST", "127.0.0.1")
EPLAN_DEFAULT_PORT = int(os.getenv("EPLAN_DEFAULT_PORT", "12000"))
# The same pool Eplanix's own TcpPortResolverService hands out from
# (12000-12100) — this bridge only *reuses* an instance already listening
# in it, it never starts a new EPLAN.exe itself (that stays Eplanix's job:
# launching one correctly needs the same context the MVC app already runs
# in). If nothing in the pool answers, an operator needs to open the
# Eplanix web app once so it starts an instance.
EPLAN_PORT_MIN = int(os.getenv("EPLAN_PORT_MIN", str(EPLAN_DEFAULT_PORT)))
EPLAN_PORT_MAX = int(os.getenv("EPLAN_PORT_MAX", "12100"))
TCP_TIMEOUT = int(os.getenv("TCP_TIMEOUT", "120"))
# How many pool ports to probe at once. The pool is 101 ports and a probe
# against a host that DROPS packets (rather than refusing them) burns its
# whole timeout, so probing one at a time costs pool x timeout — 101 seconds
# for the default pool, which is far past any caller's patience. Probing the
# whole pool at once would be quicker still, but 101 simultaneous connects to
# one host looks like a port scan; a batch keeps it to a couple of rounds.
PROBE_CONCURRENCY = int(os.getenv("EPLAN_PROBE_CONCURRENCY", "64"))
# How long to wait, after a pool port accepts, to see whether it closes again.
# A relay with nothing behind it closes within a round-trip; AsyncTcpServer
# stays silent waiting for a length prefix. Long enough to tell those apart on
# a LAN, short enough that it is paid once per scan, not per port.
RELAY_EOF_TIMEOUT = float(os.getenv("EPLAN_RELAY_EOF_TIMEOUT", "0.3"))
# Optional shared secret. Empty means "no auth" — fine while this only ever
# takes traffic from inside the compose network, but set it once /draw is
# reachable from another server (e.g. simorgh-backend across the LAN) and
# firewall this port to the callers that need it.
API_KEY = os.getenv("EPLAN_BRIDGE_API_KEY", "")

_jobs: Dict[str, Dict] = {}
# Ports this bridge currently believes are mid-request, so two concurrent
# /draw calls that both omit `port` don't pick the same busy instance when
# another one in the pool is free.
_busy_ports: set = set()
_busy_lock = asyncio.Lock()


def require_api_key(x_api_key: Optional[str] = Header(default=None)):
    if API_KEY and x_api_key != API_KEY:
        raise HTTPException(status_code=401, detail="Missing or invalid X-API-Key")


class EplanDrawRequest(BaseModel):
    project_name: str = Field(...)
    eplan_data: List[Dict[str, Any]] = Field(
        ..., description="List of EplanData objects to send to EPLAN server"
    )
    port: Optional[int] = Field(
        None, description="EPLAN TCP server port; omit to auto-pick one from the pool"
    )
    username: str = Field("agent")


class DrawResponse(BaseModel):
    job_id: str
    status: str
    message: str


class PortResolveRequest(BaseModel):
    username: str = Field("agent")


class ServerResponse(BaseModel):
    content: Optional[str] = None
    timestamp: Optional[str] = None
    error: Optional[str] = None


async def _port_answers(host: str, port: int, timeout: float = 1.0) -> bool:
    """Whether an EPLAN instance is really listening on this port.

    A bare TCP connect is not enough once a port relay is in the path, and
    there always is one: both eplan-port-forwarder and the netsh portproxy
    alternative accept the connection first and only then dial 127.0.0.1. So
    a pool port with no EPLAN behind it still completes the handshake, and
    only afterwards closes. Judged on the connect alone, all 101 pool ports
    look available, and a /draw with no explicit port is handed the lowest of
    them rather than the one EPLAN is actually on — it would fail at send
    time, on a port the bridge had just called available.

    AsyncTcpServer does the opposite: it accepts and then waits for our
    length prefix, sending nothing of its own (see HandleClientAsync). That
    is what tells the two apart — an immediate EOF is a relay with nothing
    behind it, silence is a real listener.
    """
    writer = None
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(host, port), timeout=timeout
        )
        try:
            first = await asyncio.wait_for(reader.read(1), timeout=RELAY_EOF_TIMEOUT)
        except asyncio.TimeoutError:
            return True          # held open, nothing sent — AsyncTcpServer
        return bool(first)       # b"" is EOF: a relay that could not connect
    except Exception:
        return False
    finally:
        if writer is not None:
            try:
                writer.close()
                await writer.wait_closed()
            except Exception:
                pass


async def _scan_pool(host: str, ports: List[int], timeout: float = 1.0) -> List[int]:
    """Which of `ports` answer, in pool order, probed concurrently.

    Sequentially this cost len(ports) x timeout, because a probe only returns
    early when the far end actively refuses — and the case someone is actually
    waiting on is the one where it does not: nothing deployed on the EPLAN
    machine, or a firewall dropping the pool, so every probe runs to its full
    timeout. That turned "nothing is listening" into a 101-second hang that
    every caller gave up on first, reporting a bridge timeout instead of the
    real answer. Concurrently it costs one timeout per batch.
    """
    sem = asyncio.Semaphore(max(1, PROBE_CONCURRENCY))

    async def probe(port: int) -> bool:
        async with sem:
            return await _port_answers(host, port, timeout=timeout)

    answered = await asyncio.gather(*(probe(p) for p in ports))
    return [p for p, ok in zip(ports, answered) if ok]


def _nothing_listening_detail(host: str) -> str:
    return (
        f"No EPLAN instance is currently reachable on {host}:"
        f"{EPLAN_PORT_MIN}-{EPLAN_PORT_MAX}. Either no EPLAN is running (open the "
        "Eplanix web app once so it starts one), or eplan-port-forwarder is not "
        f"running on the EPLAN machine — nothing binds {host}'s real interface "
        "without it, AsyncTcpServer listens on that machine's loopback only."
    )


async def _resolve_and_reserve_port(host: str) -> int:
    """The port a /draw with no explicit `port` uses: the first one in the
    pool that answers and isn't already busy with another request here.
    Mirrors the reuse half of Eplanix's own TcpPortResolverService — the
    half this bridge can actually do without launching EPLAN.exe itself."""
    async with _busy_lock:
        candidates = [p for p in range(EPLAN_PORT_MIN, EPLAN_PORT_MAX + 1)
                      if p not in _busy_ports]

    # Probed outside the lock: it is a second of network time, and holding the
    # lock across it would serialise every concurrent /draw behind one scan.
    answering = await _scan_pool(host, candidates)

    async with _busy_lock:
        for port in answering:
            if port not in _busy_ports:
                _busy_ports.add(port)
                return port

    raise HTTPException(status_code=503, detail=_nothing_listening_detail(host))


async def _release_port(port: int) -> None:
    async with _busy_lock:
        _busy_ports.discard(port)


async def _send_to_eplan(host: str, port: int, data: List[Dict]) -> Dict:
    """Send data to EPLAN TCP server using length-prefixed protocol."""
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(host, port),
            timeout=10,
        )

        # Serialize data
        json_bytes = json.dumps(data).encode("utf-8")

        # Send: 4-byte length prefix + payload
        length_prefix = struct.pack("<I", len(json_bytes))
        writer.write(length_prefix + json_bytes)
        await writer.drain()

        # Receive response: 4-byte length + payload
        length_data = await asyncio.wait_for(reader.readexactly(4), timeout=TCP_TIMEOUT)
        response_length = struct.unpack("<I", length_data)[0]

        response_data = b""
        while len(response_data) < response_length:
            chunk = await asyncio.wait_for(
                reader.read(min(4096, response_length - len(response_data))),
                timeout=TCP_TIMEOUT,
            )
            if not chunk:
                break
            response_data += chunk

        writer.close()
        await writer.wait_closed()

        # Parse response
        response_json = json.loads(response_data.decode("utf-8"))
        return {"status": "ok", "response": response_json}

    except asyncio.TimeoutError:
        return {"status": "timeout", "error": f"EPLAN server timeout after {TCP_TIMEOUT}s"}
    except ConnectionRefusedError:
        return {"status": "connection_refused", "error": f"EPLAN server not running on {host}:{port}"}
    except Exception as e:
        return {"status": "error", "error": str(e)}


@app.get("/health")
async def health():
    # A quick signal, not a full resolve: whether *anything* in the pool
    # currently answers, without reserving it.
    # Concurrent, and short: this is what the container healthcheck calls, and
    # it gave up at 10s while a sequential scan of a dropping host took 50.
    reachable = await _scan_pool(
        EPLAN_HOST, list(range(EPLAN_PORT_MIN, EPLAN_PORT_MAX + 1)), timeout=0.5
    )
    eplan_status = "reachable" if reachable else "unreachable"

    return {
        "status": "healthy",
        "service": "eplan-bridge",
        "eplan_server": eplan_status,
        "eplan_host": EPLAN_HOST,
        "eplan_port_pool": f"{EPLAN_PORT_MIN}-{EPLAN_PORT_MAX}",
    }


@app.post("/draw", response_model=DrawResponse, dependencies=[Depends(require_api_key)])
async def trigger_drawing(req: EplanDrawRequest):
    """Send EplanData to the EPLAN server to generate drawings."""
    job_id = str(uuid.uuid4())
    port = req.port
    reserved_here = False
    if port is None:
        port = await _resolve_and_reserve_port(EPLAN_HOST)
        reserved_here = True

    _jobs[job_id] = {
        "job_id": job_id,
        "project_name": req.project_name,
        "status": "sending",
        "started_at": datetime.utcnow().isoformat(),
        "port": port,
    }

    try:
        result = await _send_to_eplan(EPLAN_HOST, port, req.eplan_data)

        if result["status"] == "ok":
            _jobs[job_id]["status"] = "completed"
            _jobs[job_id]["response"] = result["response"]
            _jobs[job_id]["completed_at"] = datetime.utcnow().isoformat()

            return DrawResponse(
                job_id=job_id,
                status="completed",
                message=f"Drawing generated. Output: {result['response'].get('Content', 'N/A')}",
            )
        else:
            _jobs[job_id]["status"] = "failed"
            _jobs[job_id]["error"] = result.get("error", "Unknown error")

            return DrawResponse(
                job_id=job_id,
                status="failed",
                message=result.get("error", "EPLAN server error"),
            )

    except Exception as e:
        _jobs[job_id]["status"] = "failed"
        _jobs[job_id]["error"] = str(e)
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if reserved_here:
            await _release_port(port)


@app.get("/job/{job_id}")
async def get_job_status(job_id: str):
    """Check the status of an EPLAN drawing job."""
    if job_id not in _jobs:
        raise HTTPException(status_code=404, detail="Job not found")
    return _jobs[job_id]


@app.post("/port/resolve", dependencies=[Depends(require_api_key)])
async def resolve_port(req: PortResolveRequest):
    """Report an EPLAN port that currently answers, without reserving it —
    what the Simorgh dialog's "Test" button calls to say whether a draw
    would have anywhere to go right now."""
    answering = await _scan_pool(
        EPLAN_HOST, list(range(EPLAN_PORT_MIN, EPLAN_PORT_MAX + 1))
    )
    if answering:
        return {"port": answering[0], "status": "available", "host": EPLAN_HOST}

    raise HTTPException(status_code=503, detail=_nothing_listening_detail(EPLAN_HOST))


# =============================================================================
# MCP Server - Exposes EPLAN tools via Model Context Protocol
# =============================================================================
mcp = FastMCP("eplan-bridge", instructions="EPLAN TCP-to-REST bridge for drawing generation")


@mcp.tool()
async def eplan_draw(project_name: str, eplan_data: str,
                     port: Optional[int] = None, username: str = "agent") -> str:
    """Send EplanData to EPLAN server to generate drawings. eplan_data: JSON
    string of EplanData list. Omit port to auto-pick one from the pool."""
    reserved_here = False
    try:
        data_list = json.loads(eplan_data) if isinstance(eplan_data, str) else eplan_data
        if port is None:
            port = await _resolve_and_reserve_port(EPLAN_HOST)
            reserved_here = True
        job_id = str(uuid.uuid4())
        _jobs[job_id] = {
            "job_id": job_id, "project_name": project_name,
            "status": "sending", "started_at": datetime.utcnow().isoformat(), "port": port,
        }
        result = await _send_to_eplan(EPLAN_HOST, port, data_list)
        if result["status"] == "ok":
            _jobs[job_id]["status"] = "completed"
            _jobs[job_id]["response"] = result["response"]
            return json.dumps({"job_id": job_id, "status": "completed",
                               "message": f"Drawing generated. Output: {result['response'].get('Content', 'N/A')}"})
        else:
            _jobs[job_id]["status"] = "failed"
            _jobs[job_id]["error"] = result.get("error", "Unknown")
            return json.dumps({"job_id": job_id, "status": "failed", "error": result.get("error", "EPLAN server error")})
    except HTTPException as e:
        return json.dumps({"error": e.detail})
    except Exception as e:
        return json.dumps({"error": str(e)})
    finally:
        if reserved_here:
            await _release_port(port)


@mcp.tool()
async def eplan_resolve_port(username: str = "agent") -> str:
    """Find an available EPLAN server port in the pool, without reserving it."""
    answering = await _scan_pool(
        EPLAN_HOST, list(range(EPLAN_PORT_MIN, EPLAN_PORT_MAX + 1))
    )
    if answering:
        return json.dumps({"port": answering[0], "status": "available", "host": EPLAN_HOST})
    return json.dumps({"error": _nothing_listening_detail(EPLAN_HOST)})


# FastMCP's streamable_http_app exposes route /mcp internally. Mount at
# "/" so its public path is /mcp (mounting at "/mcp" would produce /mcp/mcp).
# Its session_manager needs an active TaskGroup; when the inner app is
# mounted under another FastAPI, the inner lifespan never fires — start
# the session manager from the outer app's lifespan instead, otherwise
# every POST returns 500 with "Task group is not initialized".
_mcp_streamable_app = mcp.streamable_http_app()

@app.on_event("startup")
async def _mcp_session_manager_start():
    cm = mcp.session_manager.run()
    app.state._mcp_session_manager_cm = cm
    await cm.__aenter__()

@app.on_event("shutdown")
async def _mcp_session_manager_stop():
    cm = getattr(app.state, "_mcp_session_manager_cm", None)
    if cm is not None:
        await cm.__aexit__(None, None, None)

app.mount("/", _mcp_streamable_app)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8026)
