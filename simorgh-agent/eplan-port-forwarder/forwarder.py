"""
EPLAN port-range forwarder
===========================
Runs ON THE EPLAN MACHINE (the Windows box with Eplanix + EPLAN installed),
next to the Eplanix add-in's AsyncTcpServer. It is the piece that makes
AsyncTcpServer reachable from another server without changing a line of the
eplanix repo.

Why this exists
----------------
AsyncTcpServer binds `127.0.0.1` only:

    public AsyncTcpServer(string ip = "127.0.0.1", int port = 12000)

That is correct for Eplanix's own MVC app, which runs on this same machine.
It is not reachable from `eplan-bridge-service` (this stack's HTTP-to-TCP
bridge), which runs on a different server — nothing is listening on this
machine's real network interface, only on its loopback, and a container on
Docker Desktop reaching "127.0.0.1" only ever reaches *itself*, never the
Windows host.

This process is a plain byte-for-byte TCP relay: for every port in the pool
Eplanix's own TcpPortResolverService hands out from (12000-12100 by
default), it listens on this machine's real interface and forwards each
connection to that same port on 127.0.0.1. It never parses the EPLAN
protocol — the length-prefixed JSON framing AsyncTcpServer speaks passes
through untouched — so there is nothing here that can drift out of sync
with the eplanix repo's own wire format.

It carries no authentication of its own (a raw byte relay cannot inspect
what it is asked to be a proxy for). Firewall the published ports (default
12000-12100) to the address of the machine running eplan-bridge-service —
never leave them open to the whole network.

Environment
-----------
  BIND_HOST    interface to listen on (default: 0.0.0.0 — every interface;
               Docker's own port publishing already scopes this to whatever
               `docker-compose.yml` maps, but the firewall rule is what
               actually restricts who can reach it)
  TARGET_HOST  where AsyncTcpServer actually listens. Inside a container on
               Docker Desktop, "127.0.0.1" is the CONTAINER's own loopback,
               not the Windows host's — use "host.docker.internal" there
               (Docker Desktop's DNS name for the host). Running this
               script directly on Windows instead of in a container, use
               "127.0.0.1" — that loopback is the same one AsyncTcpServer
               binds. (default: host.docker.internal)
  PORT_MIN     first port in the pool (default: 12000)
  PORT_MAX     last port in the pool, inclusive (default: 12100)
"""

import asyncio
import logging
import os

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("eplan-port-forwarder")

BIND_HOST = os.getenv("BIND_HOST", "0.0.0.0")
TARGET_HOST = os.getenv("TARGET_HOST", "host.docker.internal")
PORT_MIN = int(os.getenv("PORT_MIN", "12000"))
PORT_MAX = int(os.getenv("PORT_MAX", "12100"))


async def _pipe(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        while True:
            chunk = await reader.read(65536)
            if not chunk:
                break
            writer.write(chunk)
            await writer.drain()
    except (ConnectionResetError, BrokenPipeError):
        pass
    finally:
        writer.close()


async def _handle(port: int, client_reader: asyncio.StreamReader, client_writer: asyncio.StreamWriter) -> None:
    peer = client_writer.get_extra_info("peername")
    try:
        target_reader, target_writer = await asyncio.open_connection(TARGET_HOST, port)
    except Exception as exc:
        logger.warning("port %s: could not reach %s:%s for %s — %s", port, TARGET_HOST, port, peer, exc)
        client_writer.close()
        return

    logger.info("port %s: %s <-> %s:%s", port, peer, TARGET_HOST, port)
    await asyncio.gather(
        _pipe(client_reader, target_writer),
        _pipe(target_reader, client_writer),
    )


async def main() -> None:
    servers = []
    for port in range(PORT_MIN, PORT_MAX + 1):
        server = await asyncio.start_server(
            lambda r, w, p=port: _handle(p, r, w), BIND_HOST, port
        )
        servers.append(server)

    logger.info(
        "forwarding %s:%s-%s -> %s:%s-%s",
        BIND_HOST, PORT_MIN, PORT_MAX, TARGET_HOST, PORT_MIN, PORT_MAX,
    )
    await asyncio.gather(*(s.serve_forever() for s in servers))


if __name__ == "__main__":
    asyncio.run(main())
