# Send to EPLAN — the Eplanix tab's fourth output

The Eplanix tab already produces three things off the project: the single
line, the panel layout and the mechanical items. **Send to EPLAN** is the
fourth: the same feeder lines, handed to EPLAN over the network instead of
downloaded as a file — following the exact pattern the `eplanix` repo's own
MVC app uses to talk to its EPLAN add-in, without changing anything in that
repo.

## The path a send takes

```
Eplanix tab          this app's backend        eplan-bridge-service      eplan-port-forwarder        AsyncTcpServer
 (browser)      →      (simorgh-backend)    →   (this stack, Linux)   →  (EPLAN machine, Windows) →  (127.0.0.1:<port>,
                  POST /api/eplan/send          POST /draw               TCP :12000-12100 (LAN)       same machine)
```

Four hops, for one reason: the EPLAN listener Eplanix's add-in starts —
`AsyncTcpServer`, in `StartAction.epladdin.app1` — binds `127.0.0.1` only:

```csharp
public AsyncTcpServer(string ip = "127.0.0.1", int port = 12000)
```

That's correct for Eplanix's own MVC app, which runs on the same Windows
box as EPLAN. Simorgh Design Suite doesn't — it runs on a different server
— so nothing here ever opens that socket directly. Two hops make it
reachable anyway, without touching the `eplanix` repo or opening that
socket to the network:

- **`eplan-bridge-service`** (`simorgh-agent/eplan-bridge-service`) speaks
  EPLAN's own wire protocol — a 4-byte length-prefixed JSON array, exactly
  what `EplanixController.SendToEplanServerAsync` sends — over HTTP, so
  nothing else in this stack has to hold a raw socket. It also picks a port
  from the pool automatically (12000–12100, the same range Eplanix's own
  `TcpPortResolverService` hands out from), so a send never has to know or
  guess one.
- **`eplan-port-forwarder`** (`simorgh-agent/eplan-port-forwarder`) is a
  plain byte-for-byte TCP relay deployed *on the EPLAN machine itself*, via
  the Docker Desktop already there — its own standalone compose file, which
  pulls the workflow-built image by default and can build in place where
  ghcr.io is out of reach. It's the only thing that actually needs
  to run where EPLAN does — it forwards the whole port pool from that
  machine's real network interface to its own loopback, which is what lets
  `eplan-bridge-service` (on a different server) reach a socket that only
  ever binds loopback.

See `../eplan-port-forwarder/README.md` for why this beats the two more
obvious fixes (binding `AsyncTcpServer` to `0.0.0.0`, or a generic reverse
proxy) and exactly how to deploy it.

## What is sent

One `EplanData` record per feeder line — the exact shape of
`SharedLibrary.Models.EplanData` on the EPLAN side, built by
`src/utils/eplanDataExport.ts`. Project, switchboard, busbar, wire and
drawing values repeat on every record; the feeder values differ.

| Group | Where it comes from |
|---|---|
| draft values (`LineNumber`, `TagName`, `SizeType`, `CBOrder`…) | the Device Selection rows and the parts on the template behind each row |
| header (`hCBOrder`, `hLineNumber`…) | the TPMS column names when the switchgear came from TPMS, otherwise the app's own captions |
| switchboard, busbar, auxiliary voltage | the Device Library entry for that switchgear — the panel specification |
| `Altitude`, `DesignTemperature`, wire sizes and colours | Technical Settings |
| `Revision`, `RevName` | the revision the project is on |
| `FeedersPerPage` | the "feeders / sheet" the tab is previewing |

Fields the project genuinely does not hold (`CBRating`, the outline-drawing
block, the additional project/panel fields) are sent empty rather than
guessed — EPLAN reads an empty string as "not stated". The rating of a
device is carried by the part itself, which is why only the order numbers
are stated.

Before anything is sent, the dialog reports how many switchgears and how
many records are going, and can show the first record in full (and copy the
whole payload) — so what leaves the app has been looked at first, the same
rule the rest of the Eplanix tab follows.

## Configuration

This app's backend (`simorgh-backend/.env.example`):

```
EPLAN_BRIDGE_URL=http://eplan-bridge:8026   # the compose service name — works as-is in this stack
EPLAN_BRIDGE_API_KEY=                       # only if the bridge was deployed with one set
EPLAN_BRIDGE_TIMEOUT_MS=120000
```

`eplan-bridge-service` itself (`simorgh-agent/compose/svc-eplan-bridge.yml`):

```
EPLAN_HOST=<eplan-port-forwarder's LAN IP>   # NOT EPLAN's own IP — see below
EPLAN_PORT_MIN=12000
EPLAN_PORT_MAX=12100
EPLAN_BRIDGE_API_KEY=                        # set this once /draw is reachable from another server
```

`EPLAN_HOST` here is the address of `eplan-port-forwarder`
(`simorgh-agent/eplan-port-forwarder`), not the EPLAN machine's address
used as if it spoke this protocol directly — nothing on that machine
listens on its real interface without the forwarder running. In the common
case the forwarder runs on the EPLAN machine itself, so this is just that
machine's LAN IP.

There is nothing left to configure on the frontend — `VITE_EPLAN_API_HOST` /
`VITE_EPLAN_API_PORT` were removed along with the idea of picking a target
per send. Which EPLAN instance a send lands on is entirely
`eplan-bridge-service`'s concern, the same way an interactive Eplanix user
never sees a port picker either.

## When "Test" says it timed out

`Timed out waiting for the EPLAN bridge.` almost never means the bridge is
down. There are four hops, and only the last two usually fail:

```
simorgh-soft ──HTTP──> eplan-bridge ──TCP──> eplan-port-forwarder ──TCP──> AsyncTcpServer
 (Linux stack)          (Linux stack)         (EPLAN machine)              (EPLAN machine,
                                                                            127.0.0.1 only)
```

Test each hop on its own, in this order — the first one that fails is the
answer, and there is no point looking further down.

**1 — can this app reach the bridge?** From `simorgh-agent`:

```bash
docker compose exec simorgh-soft node -e \
  "fetch('http://eplan-bridge:8026/health').then(r=>r.json()).then(o=>console.log(o))"
```

`eplan_server: "reachable"` means all four hops are up and Test should pass.
`"unreachable"` means the bridge is fine and the problem is below it — read
`eplan_host` in the same output and check it is the EPLAN machine's LAN
address. A connection error rather than JSON means the bridge itself is not
running: `docker compose up -d eplan-bridge`.

**2 — is the forwarder running on the EPLAN machine?** On that Windows box:

```powershell
docker ps --filter name=eplan-port-forwarder
```

If it is not listed, this is the usual cause — nothing binds that machine's
real interface without it, so the bridge's probes are dropped rather than
refused. Deploy it: `cd eplan-port-forwarder && docker compose up -d`, which
pulls `simorgh-eplan-port-forwarder` the way the rest of the stack pulls its
images. On a machine that cannot reach ghcr.io, build it there instead —
`docker compose -f docker-compose.yml -f docker-compose.build.yml up -d
--build`, seconds, no package manager involved. See
`../eplan-port-forwarder/README.md`.

Note that `eplan-nginx`, `eplan-api-gateway` and `eplan-mssql` on that
machine are **not** part of this path. They belong to a different project
that is in neither this repo nor `eplanix`, and `eplan-api-gateway` is not a
substitute for the forwarder — it speaks HTTP on 8080, not the
length-prefixed TCP protocol `AsyncTcpServer` expects.

**3 — is an EPLAN instance actually listening?** Also on the Windows box:

```powershell
netstat -ano | findstr "1200 1201 1202"
```

Expect at least one LISTENING socket in 12000-12100 on 127.0.0.1. If there
is none, no EPLAN is running: open the Eplanix web app once so it starts
one. This bridge deliberately never launches `EPLAN.exe` itself — doing that
correctly needs the context the MVC app already runs in.

**4 — is the pool reachable across the LAN?** From the Linux server:

```bash
docker compose exec eplan-bridge python -c "
import asyncio, os
async def m():
    host = os.getenv('EPLAN_HOST')
    for p in (12000, 12001, 12002):
        try:
            r, w = await asyncio.wait_for(asyncio.open_connection(host, p), 2)
            w.close(); print(f'{host}:{p} OPEN')
        except Exception as e:
            print(f'{host}:{p} {type(e).__name__}')
asyncio.run(m())"
```

`OPEN` on any port means the whole path works. `TimeoutError` means packets
are being dropped — the forwarder is down, or the Windows Firewall rule
allowing this server has not been added (see the forwarder's README).
`ConnectionRefusedError` means the host is reachable but nothing is
listening on that port, which is hop 3, not a network problem.

### Why it reported a timeout rather than the real error

The bridge used to probe the pool one port at a time. A probe against a host
that *drops* packets — which is exactly what an undeployed forwarder or a
closed firewall looks like — runs to its full timeout instead of failing
fast, so scanning 101 ports cost 101 seconds. Every caller gave up long
before that and reported a bridge timeout, hiding the real answer. The pool
is now probed concurrently (`EPLAN_PROBE_CONCURRENCY`, default 64), so the
same scan takes about two seconds and the 503 it returns says which of the
two causes above it is.
