"""
EPLAN Drawing REST Bridge Service
====================================
REST API bridge to the EPLAN TCP server (AsyncTcpServer on port 12000+).
Wraps the legacy TCP protocol with a modern HTTP interface so the agent
can trigger EPLAN drawing generation.

The actual EPLAN server runs on the Windows machine (EPLANIX server).
This bridge runs alongside and converts HTTP requests to TCP.

Endpoints:
  POST /draw              - Send EplanData to generate drawings
  GET  /job/{job_id}      - Check job status
  POST /port/resolve      - Get available EPLAN port
  GET  /health            - Health check
"""

import asyncio
import json
import logging
import os
import struct
import uuid
from datetime import datetime
from typing import Optional, Dict, Any, List

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="EPLAN Bridge Service", version="1.0.0")

EPLAN_HOST = os.getenv("EPLAN_HOST", "127.0.0.1")
EPLAN_DEFAULT_PORT = int(os.getenv("EPLAN_DEFAULT_PORT", "12000"))
TCP_TIMEOUT = int(os.getenv("TCP_TIMEOUT", "120"))

_jobs: Dict[str, Dict] = {}


class EplanDrawRequest(BaseModel):
    project_name: str = Field(...)
    eplan_data: List[Dict[str, Any]] = Field(
        ..., description="List of EplanData objects to send to EPLAN server"
    )
    port: int = Field(EPLAN_DEFAULT_PORT, description="EPLAN TCP server port")
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
    # Try to connect to default EPLAN port
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(EPLAN_HOST, EPLAN_DEFAULT_PORT),
            timeout=3,
        )
        writer.close()
        await writer.wait_closed()
        eplan_status = "reachable"
    except Exception:
        eplan_status = "unreachable"

    return {
        "status": "healthy",
        "service": "eplan-bridge",
        "eplan_server": eplan_status,
        "eplan_host": EPLAN_HOST,
        "eplan_port": EPLAN_DEFAULT_PORT,
    }


@app.post("/draw", response_model=DrawResponse)
async def trigger_drawing(req: EplanDrawRequest):
    """Send EplanData to the EPLAN server to generate drawings."""
    job_id = str(uuid.uuid4())

    _jobs[job_id] = {
        "job_id": job_id,
        "project_name": req.project_name,
        "status": "sending",
        "started_at": datetime.utcnow().isoformat(),
        "port": req.port,
    }

    try:
        result = await _send_to_eplan(EPLAN_HOST, req.port, req.eplan_data)

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


@app.get("/job/{job_id}")
async def get_job_status(job_id: str):
    """Check the status of an EPLAN drawing job."""
    if job_id not in _jobs:
        raise HTTPException(status_code=404, detail="Job not found")
    return _jobs[job_id]


@app.post("/port/resolve")
async def resolve_port(req: PortResolveRequest):
    """
    Find an available EPLAN port.
    Scans ports 12000-12100 for a responsive EPLAN server.
    """
    for port in range(12000, 12101):
        try:
            reader, writer = await asyncio.wait_for(
                asyncio.open_connection(EPLAN_HOST, port),
                timeout=1,
            )
            writer.close()
            await writer.wait_closed()
            return {"port": port, "status": "available", "host": EPLAN_HOST}
        except Exception:
            continue

    raise HTTPException(
        status_code=503,
        detail="No EPLAN server available on ports 12000-12100",
    )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8026)
