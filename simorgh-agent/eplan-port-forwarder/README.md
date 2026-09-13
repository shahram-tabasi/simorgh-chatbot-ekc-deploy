# eplan-port-forwarder

Makes the Eplanix add-in's `AsyncTcpServer` reachable from another server,
without changing anything in the `eplanix` repo.

## Why this, and not the other two options

`AsyncTcpServer` binds `127.0.0.1` only:

```csharp
public AsyncTcpServer(string ip = "127.0.0.1", int port = 12000)
```

That's correct for Eplanix's own MVC app — it runs on the same Windows box
as EPLAN. Simorgh Design Suite (`simorgh-soft`) does not; it runs on a
different server, so a plain TCP connection from it (or from
`eplan-bridge-service`, which runs alongside it) never reaches that socket
at all, whatever host/IP is dialled — nothing is listening on the EPLAN
machine's real network interface, only on its loopback.

Two tempting fixes, and why they're worse than this one:

- **Bind `AsyncTcpServer` to `0.0.0.0`.** Requires editing the `eplanix`
  repo, which this task is explicitly not doing — and even if it weren't,
  it would put a raw, unauthenticated socket that deserialises arbitrary
  JSON straight onto the network, for every port an EPLAN instance ever
  gets handed. `TcpPortResolverService` can hand out any of 101 ports
  (12000–12100), so this also means opening all of them.
- **A generic reverse proxy (nginx, HAProxy) in front of it.** These are
  built around a fixed upstream per listener. Eplanix's own port pool is
  dynamic — which of the 101 ports is "the" one changes request to
  request, decided by a SQL-backed pool the proxy has no way to see. Making
  nginx follow that means regenerating its config (or scripting its
  `stream` module) every time a port's state changes — solving a problem a
  plain relay doesn't have in the first place.

This forwarder is neither: a byte-for-byte relay across the *whole* pool at
once, so whichever port Eplanix (or `eplan-bridge-service`'s own
`/port/resolve`) is actually using just works, with nothing to
regenerate. It never parses the EPLAN wire protocol, so it can't drift out
of sync with the eplanix repo's own framing. `AsyncTcpServer` itself is
untouched, still loopback-only, exactly as Eplanix ships it — only this
relay's own listener is exposed, and only that needs firewalling.

## What it does

```
eplan-bridge-service            eplan-port-forwarder             AsyncTcpServer
(on the Linux stack,     --->   (on the EPLAN machine,    --->   (127.0.0.1:<port>,
 a different server)            via Docker Desktop)               on the same machine)
        :12000-12100 (LAN)             :12000-12100 (loopback)
```

For every port in the pool (12000–12100 by default — the same range
`TcpPortResolverService` uses) it listens on this machine's real network
interface and forwards each connection, byte-for-byte, to that same port
number on `127.0.0.1`. No parsing, no state — just a relay.

## Deploy it (on the EPLAN machine, via Docker Desktop)

```
cd eplan-port-forwarder
docker compose up -d
```

That's it — `TARGET_HOST` defaults to `host.docker.internal` (Docker
Desktop's name for the Windows host it runs on), which is what
`127.0.0.1` means to `AsyncTcpServer` on that same machine. **Do not**
change `TARGET_HOST` to `127.0.0.1` for the container — inside a container,
that's the container's own loopback, not the host's, and the forwarder
would just fail to reach anything. (Running `forwarder.py` directly on
Windows instead of in a container is the one case where `127.0.0.1` is
right, because then the loopback really is the host's.)

## Firewall it

This relay carries no authentication of its own — it can't, it doesn't
look at what it's carrying. Restrict the published ports (12000–12100 by
default) with the Windows Firewall to the one address that should ever use
them: the machine running `eplan-bridge-service`. Nothing else needs to
reach this port range.

## Point the bridge at it

On `eplan-bridge-service` (in the main stack, on the other server), set:

```
EPLAN_HOST=<this machine's LAN IP>
```

See `../eplan-bridge-service/app.py` and `../docs/EPLAN_SEND.md` for the
rest of the path from Simorgh's "Send to EPLAN" button to here.

## Config

| Variable      | Default                | Meaning |
|---------------|-------------------------|---------|
| `TARGET_HOST` | `host.docker.internal`  | Where `AsyncTcpServer` actually listens, from this container's point of view. |
| `PORT_MIN`    | `12000`                 | First port in the pool. |
| `PORT_MAX`    | `12100`                 | Last port in the pool (inclusive). |
| `BIND_HOST`   | `0.0.0.0`               | Interface to listen on inside the container — Docker's own port publishing (see `docker-compose.yml`) is what actually scopes this, along with the firewall rule above. |

Change `EPLAN_PORT_MIN` / `EPLAN_PORT_MAX` in this folder's `.env` (not the
container's own env directly) if Eplanix's pool range is ever changed from
its 12000–12100 default — keep it identical on both sides of the relay.
