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

These files live in this repo, which is checked out on the Linux server —
not on the EPLAN machine. Clone it there first (or copy this one directory
across), then run from inside it:

```
git clone <this repo> C:\simorgh
cd C:\simorgh\simorgh-agent\eplan-port-forwarder
docker compose up -d
```

`docker compose up` builds from `python:3.11-slim`, so that machine needs to
be able to pull from Docker Hub. If it cannot, or you would rather not put a
container on that box at all, use the Windows port proxy below instead — it
needs no files and no image.

That's it — `TARGET_HOST` defaults to `host.docker.internal` (Docker
Desktop's name for the Windows host it runs on), which is what
`127.0.0.1` means to `AsyncTcpServer` on that same machine. **Do not**
change `TARGET_HOST` to `127.0.0.1` for the container — inside a container,
that's the container's own loopback, not the host's, and the forwarder
would just fail to reach anything. (Running `forwarder.py` directly on
Windows instead of in a container is the one case where `127.0.0.1` is
right, because then the loopback really is the host's.)

## Or: Windows' own port proxy, with no files at all

Windows ships a TCP port forwarder (`netsh interface portproxy`) that does
the same byte-for-byte relay this container does. On the EPLAN machine it is
the shortest path to a working bridge: nothing to clone, no image to pull,
and the rules live in the registry so they survive a reboot on their own.

In an **elevated** PowerShell:

```powershell
# portproxy is implemented by the IP Helper service
Set-Service iphlpsvc -StartupType Automatic
Start-Service iphlpsvc

# one rule per port in the pool: real interface -> the loopback
# AsyncTcpServer binds
12000..12100 | ForEach-Object {
  netsh interface portproxy add v4tov4 `
    listenaddress=0.0.0.0 listenport=$_ `
    connectaddress=127.0.0.1 connectport=$_ | Out-Null
}

netsh interface portproxy show v4tov4   # expect 101 rules
```

To undo it:

```powershell
12000..12100 | ForEach-Object {
  netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=$_ | Out-Null
}
```

### Does it survive a reboot?

Yes, both halves. `netsh ... portproxy add` writes the rules to the registry
(`HKLM\SYSTEM\CurrentControlSet\Services\PortProxy\v4tov4\tcp`) and
`New-NetFirewallRule` creates a permanent rule — neither needs re-entering.
Setting `iphlpsvc` to start automatically is what makes that true in practice:
portproxy is implemented by IP Helper, so without it the rules are still in
the registry after a restart but nothing is listening. Binding to `0.0.0.0`
rather than a specific address also avoids the usual portproxy-after-reboot
failure, where IP Helper starts before that address exists.

What does *not* survive a reboot is the EPLAN instance. `AsyncTcpServer` is
started by the Eplanix app, so the forwarding comes back with nothing behind
it until someone opens that app once. After a restart, check in this order:

```powershell
# is anything listening behind the proxy?
Get-NetTCPConnection -State Listen |
  Where-Object { $_.LocalPort -ge 12000 -and $_.LocalPort -le 12100 }

# are the rules still there? (expect 101)
(netsh interface portproxy show v4tov4 | Select-String "1200|1201|1202").Count
```

Rules present but nothing listening means it is the EPLAN instance, not the
plumbing — which is what the bridge reports as `eplan_server: "unreachable"`.

The trade-off against the container: this is machine configuration rather
than something in version control, so it has to be reapplied by hand if the
box is rebuilt. Everything else about it is the same — a raw TCP relay that
never looks at what it carries, which is why the firewall rule below matters
just as much here.

## Firewall it

This relay carries no authentication of its own — it can't, it doesn't
look at what it's carrying. Restrict the published ports (12000–12100 by
default) with the Windows Firewall to the one address that should ever use
them: the machine running `eplan-bridge-service`. Nothing else needs to
reach this port range.

Container traffic is source-NAT'd to its host, so the address to allow is
the Linux server's own LAN address (`hostname -I` there), not a container
address. In an elevated PowerShell on the EPLAN machine:

```powershell
New-NetFirewallRule -DisplayName "EPLAN TCP pool -> Simorgh bridge" `
  -Direction Inbound -Protocol TCP -LocalPort 12000-12100 `
  -RemoteAddress <the Linux server's LAN IP> -Action Allow
```

Check it took effect with `netstat -ano | findstr "12000"` — a listening
socket on `0.0.0.0:12000` means the relay (either kind) is up.

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
