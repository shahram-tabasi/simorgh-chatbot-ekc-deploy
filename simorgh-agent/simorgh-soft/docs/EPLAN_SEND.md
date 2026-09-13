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
  the Docker Desktop already there. It's the only thing that actually needs
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
