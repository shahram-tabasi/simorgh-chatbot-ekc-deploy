# Send to EPLAN — the Eplanix tab's fourth output

The Eplanix tab already produces three things off the project: the single
line, the panel layout and the mechanical items. **Send to EPLAN** is the
fourth: the same feeder lines, handed to the EPLAN drawing server over the
network instead of downloaded as a file.

## The address

The EPLAN machine is one IP and one port, and they live in the **backend's**
environment — `simorgh-backend/.env` when it runs on its own, and for the
deployed stack `simorgh-agent/.env`, which `compose/soft-app.yml` passes into
the container:

```
EPLAN_API_HOST=192.168.1.39
EPLAN_API_PORT=8000
EPLAN_API_PATH=/draw          # the endpoint that takes the records
EPLAN_API_TIMEOUT_MS=120000   # how long a drawing job may take
```

Changing them is an edit and `docker compose up -d simorgh-soft` — never a
frontend rebuild. That is the whole reason the address is read from the
server at runtime instead of being compiled in: the app asks
`GET /api/eplan/target` when the dialog opens.

`simorgh-frontend/.env` carries `VITE_EPLAN_API_HOST` / `VITE_EPLAN_API_PORT`
as an override, and they are **empty on purpose**. Vite bakes anything put
there into the bundle, so filling them in pins the address to whatever was
true at build time. Use them only for a locally built bundle that has to
point somewhere else.

The dialog shows whichever address is in force and lets it be changed for a
single send — useful for trying a second machine without touching a file.
**Test** opens a TCP connection to it and says whether anything is listening.

## The path a send takes

```
Eplanix tab  →  POST /api/eplan/send  →  http://<EPLAN_API_HOST>:<EPLAN_API_PORT><EPLAN_API_PATH>
 (browser)        (this app's backend)              (the EPLAN drawing server)
```

The browser never talks to the EPLAN machine directly: the backend forwards
the request. That keeps the address out of the JavaScript bundle and keeps
the EPLAN host off the browser's cross-origin path.

The body the backend posts on is what the bridge service already expects:

```json
{ "project_name": "…", "username": "…", "port": 8000, "eplan_data": [ … ] }
```

## What is sent

One `EplanData` record per feeder line — the exact shape of
`SharedLibrary.Models.EplanData` on the EPLAN side, all 177 fields, built by
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
