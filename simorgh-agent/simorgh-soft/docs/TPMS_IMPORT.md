# TPMS import — the same data Eplanix reads

Eplanix (the switchgear company's .NET app) reads **only** from the TPMS MySQL
database. Simorgh Design Suite now reads the same tables, through the same
queries, and puts the result where it belongs in a project.

There are two ways in:

- **On the project screen.** The project combo box lists the suite's own
  projects and, underneath them, every project TPMS holds — the same list
  Eplanix shows. Pick one and **Open from TPMS** reads the *whole* project:
  every switchgear, and every TPMS revision. Nothing else is asked. If a
  project for it already exists here (linked, or same PID, OE number or name)
  it is refreshed rather than duplicated.
- **Inside an open project**, from **File → Import from TPMS…** or the
  **🗄️ TPMS** button above the equipment tree in Device Selection — one
  switchgear at one revision, for pulling a single panel into a project that
  the suite already owns.

Nothing is ever written back to TPMS. If the server has no MySQL behind it,
the TPMS section simply doesn't appear and the suite's own projects open as
they always did.

## Who owns the project

A project opened from TPMS carries a link back to it (`tpmsSync`), and that
link decides who owns the data:

| `master` | What happens |
|---|---|
| `tpms` | TPMS owns it. Every time the project is opened it is read from TPMS again and written to MongoDB, and the app refuses edits — the mutation gate, Save and auto-save are all closed, and a bar across the top says so and offers **+ New Revision**. |
| `suite` | Design Suite owns it. Syncing stops; the project is edited here like any other. |

**Raising a revision in Design Suite is the hand-over.** The new revision is
created with `source: 'suite'`, the project's `master` flips to `suite`, and
the revisions TPMS wrote stay behind as history. There is no way back other
than opening the TPMS project again as a new project.

If TPMS cannot be reached when a linked project is opened, the copy stored
here opens instead and the dialog says so — an unreachable database never
stands between the user and their project.

## Revisions

TPMS revision *N* becomes **REV N** here, carrying that revision's whole
project as its snapshot — every switchgear as it stood at that revision. So
the revision list in Design Suite *is* the revision history in TPMS, and
**Output Types → Compare revisions** is where TPMS's changes are read: pick
two revisions and it lists what changed in the master data, the technical
settings, the panel specifications, the feeder lines and the parts on their
templates, with an Excel of the same.

Revisions this side has that TPMS does not — one from a revision since
removed there, or the empty REV 0 the backend creates for a project with none
— are cleaned up on each sync. A revision raised in Design Suite is never
touched.

## What is read

| TPMS | Used for |
|---|---|
| `View_Project_Main` | OE number, project name (EN/FA), project expert, technical supervisor |
| `view_scope` + `CODING_SECONDARY_GRP_TB` | the switchgear, its type, cell count, and whether it is LV or MV |
| `technical_project_identity_` | Technical Settings (altitude, temperature, wire sizes and colours, paint) |
| `technical_panel_identity` | the panel specification → a Device Library entry |
| `TECHNICAL_PROPERTIES` | the titles behind the coded fields in the two tables above |
| `View_draft` | one feeder line per row → Device Selection rows |
| `View_draft_Equipment` | the parts on each line → the line's template |
| `Technical_draft_lable_eplan_TB` | the EPLAN label for a part code |
| `View_draft_column` | this project's own names for the part columns |

The LV/MV decision is Eplanix's: a switchgear type containing SIMOPRIME, EK36
or 8BK is MV, everything else LV.

## Where it lands

- **Project Definition → Project Data** — project name, OE number, PID, planner
  (project expert), design office (technical supervisor), Persian name as the
  description.
- **Project Definition → Technical Settings** — merged field by field over what
  the project already has, so nothing TPMS doesn't carry is wiped.
- **Project Definition → Device Library** — one entry named after the
  switchgear, carrying the panel specification (frequency, busbar
  configuration and sizes, dimensions, insulation and service voltage, IP, RAL,
  access, coating, pad locks…). Coded fields are resolved through
  `TECHNICAL_PROPERTIES`, falling back to the field's remark text exactly as
  Eplanix does.
- **Device Selection** — the switchgear itself, linked to that library entry,
  with one row per feeder line: BUS SECTION, FEEDER NO., WIRING TYPE, RATING
  POWER, FLC, TAG, DESCRIPTION, MODULE NO., SIZE, SFD/HFD, CABLE SIZE.
- **Create Template** — a template per distinct part set. Lines that carry the
  same parts share one template; a second, different set under the same TPMS
  name becomes `name (2)`. The project's column names from `View_draft_column`
  ride along as the template's display names.

## Part codes

The code shown for a part follows Eplanix's `FormatSCODE`, unchanged:

1. the EPLAN label for its `ECODE`, when there is one;
2. otherwise `SCODE` — except that a blank `SCODE`, or an `LV Current
   Transformer`, falls back to `SHR_DES` and then `ENG_DES`;
3. slot 15 (test block) keeps only what is inside the brackets.

Quantities greater than one show as `× N`, the same way Eplanix prints them.

## Equipment slots → template properties

TPMS numbers the part columns; the numbers mean the same thing in both apps.
Slots 1‑17 line up with the LV property list one for one. Slots 18 (F.C/soft
starter) and 19 (surge arrester) have no LV property of their own, so on LV
they land in SPARE 6 and SPARE 7 — the two spare rows LV has beyond MV's five.
On MV, slot 19 is SURGE ARRESTER, as it is in Eplanix.

## Re-importing

Importing the same switchgear again refreshes it in place: the same equipment,
its rows rebuilt, its templates replaced by name, its library entry updated.
Everything else in the project is left alone.

## Heavy projects

A project with dozens of switchgears and a decade of revisions used not to
open at all. Three things were in the way, and all three are fixed:

- **The EPLAN label join.** `Technical_draft_lable_eplan_TB` holds one row per
  entry, so an ECODE relabelled three times has three rows — and joining it
  directly multiplied every part row by that count. Both line queries now join
  the newest label per ECODE (`MAX(id)`), which also removes duplicated parts.
- **One enormous request.** A revision used to be read for the whole project
  at once. The client now walks it **switchgear by switchgear**
  (`?scopeId=`), three at a time, so no single request is large and one
  unreadable switchgear costs only itself — the import says which, and opens
  the rest.
- **The proxy timeout.** The host nginx gave `/simorgh-design-suite/` 120
  seconds; the project read on a big project takes longer than that and came
  back as a 504. It is 600s now, matching the container's own nginx.

- **The body-size limits — the one that actually stopped them.** Reading a
  project was never the problem; *saving* it was. A project's snapshot is the
  whole project, and for 01A11766 (14 switchgears, 14 revisions, 2968 lines,
  38 000 part rows) each write is about **1.15 MB** — one for the project and
  one per revision. `express.json()` defaults to **100 KB** and nginx's
  `client_max_body_size` to **1 MB**, so every one of those writes came back
  413 while the reads sailed through in milliseconds. The backend now takes
  100 MB (`JSON_BODY_LIMIT`), and both nginx layers say `client_max_body_size
  100M`.

The dialog also offers **Newest only** instead of all revisions — the quick
way into a project with a long history; the revisions already stored here are
left untouched.

MongoDB itself was never the limit: 1.15 MB is a fourteenth of what one
document holds. A snapshot that did approach 16 MB is now reported by name
instead of failing as a database error, and a revision that will not save
costs only itself — the rest of the project still lands, and the dialog lists
what did not.

## Engineering outputs

Three outputs live in their own **Eplanix** tab, built from what TPMS brings
in:

- **EPLAN single line — دیاگرام تک‌خطی.** One EPLAN page per feeder: an Excel
  in the column order EPLAN's device-list import reads (page, higher-level
  function, location, device tag, function text, part number, type number,
  manufacturer, quantity), plus the drawing itself, laid out the way SIMARIS
  draws a board: the supply at the top left with its own devices, a busbar
  across the sheet carrying its configuration, rating and Icw, one branch per
  outgoing feeder with its devices in slot order and each device's tag and
  code beside it, the load at the foot (a motor where the feeder says so), and
  a data block under every branch — feeder, tag, description, template,
  rating, cable, position. Sheets are paginated, 4 to 12 feeders each.
- **Panel layout — جانمایی.** MODULE NO. is `column.position` and SIZE is the
  height in modules (LV) or cells (MV); read together they are the front
  elevation. The drawing stacks each column in position order and shows the
  free space left; the Excel lists every feeder with its column, position,
  from/to and size.
- **Mechanical items — اقلام مکانیکال.** The enclosure, busbars,
  compartments, finish and hardware, counted from the panel specification and
  the feeders. Every row carries a **Basis** column saying what it was derived
  from ("one per cell — cell count stated by TPMS (12)", "12 cell(s) × 800 mm
  cabinet width"); nothing is estimated from outside the project, and a row
  the project has no data for is left out rather than guessed.

## EPLAN symbols on the single line

Each template row was picked from EPLAN's parts database, and a part there
carries *function templates* — each naming the symbol EPLAN places for it and
what the part is ("Circuit breaker, 3 pole", "Current transformer"). The
single line follows that instead of guessing from the slot the part sits in:

1. `POST /api/eplan-symbols/lookup` asks the parts database for the symbol of
   every part on the project's templates, matching on part number **and**
   order number (TPMS usually carries the order number).
2. The part's **function definition** decides the symbol drawn — breaker,
   disconnector, contactor, overload, CT, PT, meter, relay, arrester,
   transformer, capacitor, drive, motor.
3. If a symbol exported from EPLAN sits in the symbol folder under that
   symbol's name (`SG3.svg`), that graphic is drawn instead — the office's own
   symbol, in the app's sheet.

### The symbol library

`src/utils/iecSymbols.ts` is the library the drawing uses — 61 single-line
symbols drawn from **the office's own legend sheet** (the `SYMBOL /
DESCRIPTION` table the SLD set carries on its last sheet), not from a generic
IEC list, so a sheet this app produces reads the same as the sheets the office
already issues. Every symbol is drawn to the same cell so they stack on a
branch: entered at the top, left at the bottom, and whatever reaches sideways
(a CT's secondary, a relay box) goes right, where the tag and the code are
written. The whole set is on screen under **Eplanix → Symbols**, and prints
from there.

The shapes, as the legend draws them:

| Device | Symbol |
|---|---|
| V.C.B | isolating contacts top and bottom, the blade open to the upper left, the trip cross on the line |
| V.C.B with racking | the same, with the motor circle and the racking box beside it |
| Vacuum contactor with HRC fuse | the isolating contacts, the fuse, the contactor arc |
| Circuit breaker | the blade with the cross on the fixed contact |
| Disconnector | an open blade between two contacts |
| Switch disconnector | the blade with the load-break bar on the fixed contact |
| Contactor | the open contact with the contactor arc under it |
| Miniature circuit breaker | the hooked blade with the arrow |
| Earth switch | the blade down to the earth symbol |
| HRC fuse | a rectangle with the diagonal through it, marked `3` |
| Thermal overload (bimetal) | a rectangle with the half-split square inside it |
| Surge limiter / surge arrester | a box with the cross / with the filled triangle |
| Protection relay | a box carrying `PROTECTION RELAY` |
| Current transformer | one circle on the line, secondary to the side, marked `1` |
| Core balance CT | an ellipse with the three phases through it |
| Two-winding transformer | interlocking circles with their star points |
| Meters | a square carrying `A`, `V`, `M`, `TD`, `F`, `H.M`, `W`, `VAR`, `COSΦ`, `PTC` |
| kWh / kVArh meter | a box with the band across the top |
| Selector switches | a box carrying `V.S` or `A.S` |
| Alarm annunciator | the four-by-four window grid |
| Test box | a circle with the dot, in the line |
| Motor / generator | a circle carrying `M` or `G` |
| Capacitor delta, magnet, heating element, LCS, ATS, bus duct, key interlock, capacitive divider | as the legend draws them |

### Series and parallel

A device is either **in the power path** — the line runs through it — or it is
an **instrument** working off a transformer beside the line. The drawing keeps
the two apart, because a single line that puts an ammeter in the power path
reads as a board with an ammeter in series with the motor:

* the power path runs down the branch: breaker, contactor, fuse, CT, core
  balance CT, surge arrester…
* the instruments hang beside it, in groups — one group per transformer that
  feeds them, each group starting level with its own transformer:
  * the **CT** feeds the ammeter, the selector, the meters and the
    **protection relay**;
  * the **core-balance CT** feeds the **earth-fault relay**, and its second
    connection comes down its own elbow into the protection relay, which works
    off both;
  * the **VT** feeds the voltmeter, its selector and the frequency meter;
  * an instrument no transformer on the line feeds is control wiring, drawn
    with the dashed link the legend uses for it.

### The sheet

A sheet is drawn the way the office draws one: the incoming column on the
left, the busbar across with its rating written above it (`BUS A, 400 V,
3P + N + PE, 4000 A, 50 kA / 1 Sec`, from the panel specification), one branch
per feeder — tag in black, part code in blue, accessories under the device,
and the text of a device that feeds an instrument written above its connection
so nothing is written over anything — and under the drawing the data block:
one row per property (BUS, Line, Type, Power, Nominal Current, Position, Tag,
Description, Cable) and one column per feeder, each column standing under its
own branch.

Each device is given the room its own text needs, so a device carrying three
accessories pushes the next one further down instead of running into it. The
sheet is sized by its viewBox, so a wide one is scaled to fit the screen
rather than running off the side of it.

### One slot, one device

A slot is one device. The first part in a slot is the device — the breaker,
the contactor, the CT — and everything after it in that slot is its
accessories: an auxiliary switch, a shunt trip, a terminal cover. Those are
written under the device (`+ Q:3VA9988-0AA12 ×2`), never drawn as a second
switch on the line, which is what a single line means by a device.

`GET /api/eplan-symbols/schema` reports which table and columns this EPLAN
database keeps its symbols in; nothing is hard-coded, because the schema
differs between EPLAN versions. If the parts database is out of reach, or
holds no symbol for a part, the drawing falls back to the slot mapping and the
Eplanix tab says so.

The symbol folder is `simorgh-backend/eplan-symbols/`, mounted read-only into
the container at `/app/eplan-symbols` (`EPLAN_SYMBOL_DIR`) — adding a symbol
is a copy, not a rebuild.

## The API

| Route | What it returns |
|---|---|
| `GET /api/tpms/projects` | the project list (value, code, name, text) |
| `GET /api/tpms/project/:projectId` | the project, its technical settings, its switchgears and its revision numbers |
| `GET /api/tpms/project/:projectId/revision/:revision` | every switchgear's feeder lines at that revision, in one read |
| `GET /api/tpms/scopes/:projectId`, `…/revisions/:scopeId`, `…/import` | the per-switchgear import, unchanged |

## Note on the three pickers

`/api/tpms/projects`, `/api/tpms/scopes/:projectId` and
`/api/tpms/revisions/:scopeId` used to query `ViewProjectMains`, `ViewScopes`
and `ViewRevisions` — the names of the C# model classes, not of the database
objects. They now query `View_Project_Main` and `View_draft`, which is what
TPMS actually has. The project list also returns `code` (OE number) and
`name` separately, so the combo box can show the OE number muted in front of
the name the way it does for the suite's own projects.
