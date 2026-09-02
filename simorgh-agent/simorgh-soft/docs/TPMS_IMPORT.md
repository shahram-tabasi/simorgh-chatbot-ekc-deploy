# TPMS import — the same data Eplanix reads

Eplanix (the switchgear company's .NET app) reads **only** from the TPMS MySQL
database. Simorgh Design Suite now reads the same tables, through the same
queries, and puts the result where it belongs in a project.

There are two ways in:

- **On the project screen.** The project combo box lists the suite's own
  projects and, underneath them, every project TPMS holds — the same list
  Eplanix shows. Pick a TPMS project, pick its switchgear and revision, and
  **Open from TPMS** reads it and opens it as a project. If a project for it
  already exists (same PID, OE number or name), it is refreshed rather than
  duplicated; otherwise a new one is created.
- **Inside an open project**, from **File → Import from TPMS…** or the
  **🗄️ TPMS** button above the equipment tree in Device Selection — project →
  switchgear → revision, read it, tick what to bring in, import.

Nothing is ever written back to TPMS. If the server has no MySQL behind it,
the TPMS section simply doesn't appear and the suite's own projects open as
they always did.

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

## Note on the three pickers

`/api/tpms/projects`, `/api/tpms/scopes/:projectId` and
`/api/tpms/revisions/:scopeId` used to query `ViewProjectMains`, `ViewScopes`
and `ViewRevisions` — the names of the C# model classes, not of the database
objects. They now query `View_Project_Main` and `View_draft`, which is what
TPMS actually has. The project list also returns `code` (OE number) and
`name` separately, so the combo box can show the OE number muted in front of
the name the way it does for the suite's own projects.
