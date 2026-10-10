---
name: simorgh-soft
description: Working on Simorgh Soft — the Design Suite at simorgh-agent/simorgh-soft (Simorgh Draw, the symbol library, the page tree, device selection, templates, Send to EPLAN). Use for any change to that app: where it lives, how to check a change before pushing, how to see a UI change in a real browser, the drawing rules a symbol must obey, and how it is deployed. Not for the chatbot services under simorgh-agent/*-service.
---

# Simorgh Soft

The electrical design suite: a switchgear project goes in as device selection
and templates, and single lines, wiring diagrams, panel layouts and an EPLAN
handover come out. **Simorgh Draw** is the drawing side of it — the canvas, the
page tree, the symbol library, the assistant.

## The owner's standing rules — read first, every time

**Change only what was asked.** Do not remove, change, add or reduce any
behaviour of the app unless the user asked for that exact thing. A fix that
seems to need a wider change — another screen, another flow, a new feature, a
"while I'm here" cleanup, a different default — is *proposed and asked about
first*, never pushed. When a request is ambiguous, ask. When reporting, list
separately anything done beyond the literal request so the user can say keep
or revert — and do not revert it on your own either.

**A TPMS project is read-only until a revision is raised.** While
`tpmsSync.master === 'tpms'` nothing in the project may be edited or saved:
`guardEdit()` refuses every mutation and `saveProject()` refuses to write, and
the user is shown the notice that raises a revision. Raising a revision in
Design Suite (`master` → `'suite'`) is the one and only way to make it
editable. Nothing may open a side door around this — not locks, not merges,
not the assistant, not an import, not a "small" edit path. Every new way to
change project data goes through `guardEdit()`.

## Where things are

Everything is under `simorgh-agent/simorgh-soft/`:

| Path | What |
|---|---|
| `simorgh-frontend/src/components/SimorghDraw/` | the editor, page tree, symbol library, symbol pages |
| `simorgh-frontend/src/components/Eplanix/EplanixTab.tsx` | the Simorgh Draw tab — the way in |
| `simorgh-frontend/src/utils/cad/` | geometry, shapes, DXF/SVG/PDF/EPLAN .ema back-ends, pages, symbol sources |
| `simorgh-frontend/src/utils/iecSymbols.ts` | the built-in single-line library |
| `simorgh-frontend/src/utils/cad/wdSymbols.ts` | the wiring-diagram library |
| `simorgh-frontend/src/components/PLC/` | the PLC page — tree, editors, instruction catalogue, assistant |
| `simorgh-frontend/src/utils/plc/` | the program model, the instruction catalogue, the checker, the SCL exporter |
| `simorgh-backend/` | Express + Mongo: projects, the office symbol library, EPLAN bridges |

`simorgh-agent/frontend` is a **different app** (the chatbot). Don't edit it for
a Simorgh Soft request.

## Checking a change

From `simorgh-agent/simorgh-soft/simorgh-frontend` (`npm ci` first if there is
no `node_modules`):

```bash
npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c 'error TS'   # expect 22
npx eslint src/components/SimorghDraw/                        # expect 2 errors
npx vite build                                                # must be clean
```

**The 22 tsc errors and the 2 eslint errors are the baseline** — `import.meta.env`
typing, unused vars, a `PropertyValue` mismatch in the template tab. They were
there before and are not yours. Count before and after; the number must not go
up. Don't "fix" them as a side quest.

## Seeing it in a browser — do this for any UI change

Typecheck says nothing about a panel whose canvas is cut off or a button pushed
off the edge. Every UI bug reported against this app so far was a layout bug
that compiled perfectly. Build a throwaway harness, look at it, then delete it:

```bash
cd simorgh-agent/simorgh-soft/simorgh-frontend
# src/__preview.tsx mounts the component inside <ProjectProvider>;
# preview.html loads /src/__preview.tsx
npx vite --port 5199 --strictPort &
# the dev server serves it under the app's base path:
#   http://localhost:5199/simorgh-design-suite/preview.html
```

Drive it with Playwright — Chromium is already on the box, don't install one:

```js
chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
```

Screenshot at several sizes (1600, 1280, 1100, 860, 700 wide) **and** with the
editor in its own full screen. Delete `src/__preview.tsx` and `preview.html`
before committing.

For symbols there is a faster path — render them straight from the source with
esbuild, no app needed:

```bash
npx esbuild render.mjs --bundle --platform=node --format=esm --outfile=out.mjs && node out.mjs
```

## Rules the code keeps

**A symbol never joins its own terminals.** A breaker, disconnector, contactor
or switch is drawn *open* — that is what the symbol means, the state it sits in
until something operates it. Nothing may draw a conductor from one terminal to
the other past an open blade: not the library, not an override, not a redraw,
not the office's DXF pack. `drawIecSymbol` places geometry and adds nothing;
only a *picture* override gets a lead, because a letterboxed image has no
geometry to connect to.

**The conductor's place does not move.** `pinX` is where the branch line runs
through a symbol. A symbol redrawn on the symbol page keeps it, or the device
lands beside the wire instead of on it.

**`lang.ts` is three languages.** `Strings` is an interface; en, fa and tr each
implement it, so a key added to one and not the others is a type error. Write
all three. The toolbar keeps its left-to-right order in every language; only
running text turns for Persian (`dirOf`).

**Full screen is the browser's own.** The editor calls `requestFullscreen` on
its frame, and the browser paints only that element's subtree. Anything
portalled to `document.body` mounts, takes clicks and is invisible. Overlays use
`useOverlayHost()` (`components/SimorghDraw/overlayHost.ts`). z-index cannot fix
this and did not.

**An embedded editor fills its box.** `DrawingEditor`'s canvas is 620px tall
unless `embedded` is set; inside a shorter panel that puts half the drawing and
the Save button below the window. Pass `embedded`; pass `lean` as well when the
host owns full screen and the symbol library.

**A feeder number is not unique.** A busbar section carries many rows under
one number, and this office's sheets do. Anything matching Excel rows to table
rows queues them per number and claims each table row once — one table row per
sheet row, and a number the table does not have is a new row. Matching on a
number as if it were a key silently threw sixteen rows away and called them
deleted.

**A placed symbol carries its id** (`Pen.symbol`), so a symbol redrawn for the
project can replace the ones already on the sheets (`utils/cad/replaceSymbol.ts`).
Keep stamping it when adding a new way to place a symbol.

**A symbol is drawn inside a frame, and the frame is not geometry.**
`utils/cad/symbolFrame.ts` says the box a symbol must fit, where its conductor
runs and where the current enters and leaves. The symbol page draws it through
`DrawingCanvas`'s `guides` — outside the shape list, `pointerEvents: none` — so
it cannot be picked, dragged, deleted or saved. It is the paper. A boundary
that lives in `shapes` is gone the first time somebody presses Ctrl+A, Delete,
and then nothing on screen says where to draw.

**Every box in `replaceSymbolInstances` is measured on the ink.** A connection
point is a ring on the edge of a symbol with half of it outside, so a box
measured round the points is ~5% taller than the device — and that box is what
the replacement is scaled to. Measured inconsistently it grew the symbol 5.5%
per redraw (40 → 52 units over five) and walked it off its wire. `inkOnly` is
one function for that reason: the three boxes have to be measured alike.

**Importing a DXF means two opposite things, so there are two buttons.** On a
sheet it is *more* geometry and belongs where the draughtsman is looking
(`placeDxf`). On the symbol page the file **is** the symbol: it replaces the
drawing, fitted to the frame (`fitIntoFrame`). Brought in through the sheet's
button it landed beside the old drawing at the pan offset, both were saved, and
the device came out drawn twice on every sheet. `ownDxfImport` hides the ribbon
button **and does not render its file input** — a hidden input is still the
first one on the page and still wired to the other meaning.

**Replacing the sheet resets the editor's dirty flag.** `DrawingEditor` reports
`onDirty` from its own `touched`, and a new `sheets` array is a sheet nobody has
drawn on. A host that replaces the content itself has to track that — the symbol
page keeps `rev`/`savedRev` — or Save goes grey on the one change the page
exists to make, and `onSaveEdits` hands back nothing for that sheet.

**A generated sheet is written as SVG and read back as geometry**
(`eplanSingleLine` → `cad/fromSvg`), and that round trip drops everything
except the lines unless the markup says otherwise. Every device is wrapped in
`<g data-block data-symbol data-name>`; `fromSvg` stamps those onto each shape
inside. Without it a breaker on a sheet is eleven lines that stopped being a
breaker: it cannot be picked as one object and `replaceSymbolInstances` finds
nothing, so redrawing a symbol searched every page in the project and
truthfully reported it was drawn nowhere. The block id is `d.<symbol>.<x>.<y>`
— unique on a sheet and stable across layouts, which an incrementing counter
would not be. Anything new that draws a symbol onto a generated sheet wraps it
the same way.

**The symbol library is module-level, so anything that draws from it must
subscribe.** `useSymbolLibrary()` is mounted once in `App` and owns loading all
three layers (project redraws, the office DXF pack, EPLAN's exported symbols —
`iecSymbols` keeps them separate, project first). Every screen that draws a
symbol calls `useSymbolVersion()`. Each tab used to load the layers from its own
effect and nothing re-rendered when they changed, so what a symbol looked like
depended on which tabs had been opened and in what order — the library showed
the new drawing and the template preview showed the old one.

**"Redraw from the library"** (`redrawAllSymbols`) puts every redrawn symbol on
every page of the set, keeping everything else drawn on them. It pairs the
library's own drawing as `from` with what is drawn now as `to`, which is what a
page holds; a page carrying an *older override* is the one case it cannot place
exactly, because the conductor is worked out from a drawing nobody kept.

**A low-voltage board never gets a medium-voltage symbol.** `symbolForPart`
takes the tier and folds MV-only symbols onto their LV equivalents (`vcb` →
`circuit-breaker`, `vacuum-contactor-fuse` → `contactor`). Only the *automatic*
reading is constrained — a symbol an engineer picked by hand is left as picked.
Without it a part described "1250A VCB panel" on an LV board matched `vcb` on
its description, and the withdrawable isolating contacts of an MV cell — two
filled bars — became the heaviest mark on every feeder.

**An accessory is not a device on the branch.** A slot nothing can identify
used to fall back to the `accessory` symbol, an empty dashed square on the
conductor: the software writing "I don't know what this is" into a customer's
drawing, sixteen times on an eight-way board. Those parts are written against
the branch's first device instead, tag and all.

**The sheet's numbers come from what is on it.** The column width is derived
from `branchDx + the widest symbol's reach + the clipped code`, not a flat 200
that was right for a cell with instruments and half empty for a plain feeder.
Text is sized against the cell (a tag is about a quarter of `CELL`), and
`TEXT` states every offset once because `deviceText` writes them and `stepFor`
spaces by them — when they disagreed, a device's last accessory line sat
exactly on the next device's symbol.

**A redrawn symbol reaches the sheets by itself.** A sheet nobody hand-edited
regenerates; one that was edited is frozen geometry and kept the old symbol
forever. `DrawingEditor`'s seeding effect now catches those up: where the kept
edit's `drawnAs` no longer matches the sheet it was made against, every redrawn
symbol on it is replaced, everything else drawn on it is left alone, and it
says so. The manual "Redraw from the library" stays for sheets that are not
stale but hold an older drawing.

**A terminal says which way its wire leaves** (`Pen.pinDir`, set on the symbol
page). `routeBetween` obeys it; without one it falls back to the old longest-
axis guess. Carry `dir` wherever terminals are carried — `SymbolArtOverride`,
`SymbolOverride`, `LibraryItem`, `OfficeSymbol` — or a redrawn symbol gets two
invented points on its conductor and a wire drawn to a side tap joins nothing.

**Autoconnecting lines are derived, never edited** (`utils/cad/autoconnect.ts`).
EPLAN's rule: two connection points of different devices that face each other
on one line are joined. They are WIRE-layer lines carrying `Pen.auto` (the pair
they join), so exports, nets, numbering and the connection list read them like
any wire — but every change to a sheet (`commit`, `draw`, placing) takes them
off and works them out again with `refreshAutoconnect`. Anything new that
writes a sheet's shapes from an edit goes through it, and remaps the selection
with the `index` it returns. A point with a hand-drawn wire on it is left
alone, so generated sheets are never doubled.

**A terminal's direction turns with its device** (`mapPinDir` in `geom.ts`):
rotate or mirror a block and each `pinDir` goes through the same transform.
A horizontal symbol is stored upright with `orientation: 'horizontal'` and is
laid down only on its symbol page and when the library places it — every
single-line consumer keeps reading the upright drawing.

**Connection point designations are worked out, not kept** (`pinLabels.ts`):
drawn beside each placed point while the PIN layer is shown, and printed in
the exports the same way. A connection's name and description are wire labels
(`nameConnection`), so "Number wires" skips a named connection.

**Connectors join, they are not devices** (`utils/cad/connectors.ts`). Angle,
T-node and interruption point carry `symbol: 'conn:…'`. `terminals()` leaves
the angle's and T-node's points out unless asked (`withConnectors`), so every
list reads straight through them; `devices()` leaves all connectors out.
Autoconnect and the connect tool ask for them.

**Reports are pages worked out, never kept** (`utils/cad/reportPages.ts`).
The set's chosen reports (`drawingDocs.reports`) are generated after its own
pages every time the set opens, in A3 at one unit to the millimetre, with the
same `sheetHeader` the pages use. The sign-off (`drawingDocs.titleBlock`) goes
into every title block: an `image` shape for the logo and each signature — a
data URL, drawn on screen, in SVG and in the PDF (jsPDF `addImage`), left out
of DXF. A new place that draws a shape type must handle `image`.

**An MV cell is drawn as connections, not as a column** (`drawMvCell` in
`eplanSingleLine.ts`). The switch's 3 → mechanical interlock 1, interlock 2 →
earth switch 2, earth switch 1 → the line after the switch, earth switch 3 →
magnet 1, magnet 2 → the downstream feeder, named on the line. EK36 has the
earth switch before the CT; every other family has the CT first. The points are
the symbol's own when it was drawn with terminals named 1/2/3, `LIBRARY_PINS`
otherwise. What the parts cannot say is asked on the template screen
(`SingleLineQuestions`, kept as `template.singleLine` through
`setTemplateSingleLine`); a key left out means "work it out from the parts".
Beside every device the sheet writes `label : SIM-TABLE value` (`partCode`)
and nothing else — the numbered tag and the part entry are the tooltip.
The cell type in the path (`mvCellType`) decides the panel (`cellKind`): which
switch it draws, whether it has a VT, how its line ends (`MvEnd` — a coupling
joins the riser beside it under a broken bus, a cable connection ends in a
sealing end, a dummy and the neutral panel are off the bus) and which
questions it is asked (`mvAsks`). On an MV board only a *feeder* cell can be
the supply: the old wording test took the coupling and the incoming VT cell.
Since the owner asked for EPLAN/SIMARIS-style ends, there is no separate
supply column when a row is an incomer: `roleOf` (Type, Description,
template name, tag, feeder no.) marks each row incoming / coupling / riser /
outgoing. An incomer is a cell under the bus fed from below (MV `cable-in`,
LV arrow up, `lvEnd`); a coupling joins the riser beside it, or with none
rises in its own column (`ownRiser`) to the next section; the bus section ends at the coupling's tap and the next starts at the riser (nothing between them, owner's rule)
there — MV and LV alike. The placeholder supply arrow is drawn only when no
row of the switchgear is an incomer.
Secondary side, the owner's rule (both `drawBranch` and `drawMvCell`):
the CT has one line on to the next device — the relay on the protection
core; on the measuring core the auxiliary CT (`isAuxCt`, its sample TO LCS)
or else the transducer (TO LCS / PDCS, `defaultSend`), the multimeter and
other meters, the ampere selector, and the ammeter last, a dead end (a serial
link after it may come later). `INSTRUMENT_RANK`/`rankOf` hold that order.
The VT is never on the CT's line: it is a shunt beside the line (old LV
branch: `SHUNT_SRC` group source) feeding the voltage selector then the
voltmeter on its own lane; a "CT" whose text reads as a VT ratio
(`LOOKS_VT`) is drawn as the VT. Control devices (lamp, alarm, LCS, PTC, hour
meter) hang on no transformer. Incoming and coupling columns are
`WIDE_ROLE` (1.45×) wider than a feeder's.

**Each part answers for itself** (`part.sld`, asked in `PartQuestionsDialog`
when the part is entered and from its edit button in the parts list). A later
part in a row is an accessory unless it says it is a main device: an
accessory is never drawn, its SIM-TABLE is written under its device's. A main
device is in series or in parallel **with the part drawn above it**
(`ChainItem.anchor`): series is on from it, in line with it; parallel is
joined where it is joined, beside it (on the line: tapped just before it; a
side-fed meter: its own tap off the column, while series carries on in the
row from its 2). An instrument never goes onto the power line. A relay is main
(the CTs go into it) or auxiliary, wired to any of the breaker, the main relay
and other parts by key (`sld.connects`, `slot#index` — the alarm window). The
breaker's upstream interlock and its 94/CR/74/86 boxes, the magnet's
downstream interlock and the VT's fuses / PT truck are the parts' own answers
too (`withPartAnswers`); the template keeps only what is the cell's (bus
section, connected to, neutral), asked in the wizard. There is no
template-level single-line panel any more. On MV the row
decides what a part is before its wording does (`MV_ROW_IS`), then the
office's letters in a spare row (`mvFromLabel`). Every label is broken onto
lines (`labelLines`, at commas, words, then dashes) and every layout step
makes room for the lines — a label never runs over the drawing. The line is
drawn between devices, never under them.

**Signals run to the foot of the cell, all to one level.** A relay's serial
link and statuses, a breaker's statuses (carrying on the interlock's dashed
line) and the magnet's line are collected by `signalDown` and drawn last by
`drawSignals`, so every arrow ends on one floor — the sheet passes the level
of the cell's own final arrow (`floorAt`). A relay's functions from its
window are written in its box in place of PROTECTION RELAY.

**What the generator writes, `fromSvg` has to read.** The sheets and the
template graphic reach the editor through `cad/fromSvg`: a `<polyline>`, a
`<tspan>` line or a `rotate()`d label it does not read is simply missing from
the editor and every export. It reads all three now; anything new the single
line writes is checked in the editor too, not only in the preview. A white
patch is paper there — a line that must not run under its text stops either
side of it.

**Crossings are bridged, never drawn through.** While an MV cell is drawn,
`line`/`dashed`/`solidPath` record segments instead of writing them
(`SEGS`); `writeSegs` then gives every horizontal line a hop over each
vertical it crosses. A line that ends on another is a junction with a dot, not
a crossing. Anything new drawn in a cell goes through those three helpers, or
its crossings go unbridged. Lines in an instrument column run point to point
(`stack`'s `enter`/`cursor`) and stop at a device with no way out.

**A template's graphic opens in a tab of its own**
(`?view=template-graphic&projectId&templateId`, `TemplateGraphicPage`). It
holds no project: the project's tab announces templates, symbols and edits
on `TEMPLATE_GRAPHIC_CHANNEL`, and a Save there comes back as a message that
ProjectContext applies through `patchProjectData` — the same edit gate.
With the project's tab closed it is read-only from the server.

**What a screen looks like follows the simorgh-ui skill** (`.claude/skills/simorgh-ui/`):
neutral surfaces, one blue accent for the primary action, colour only for
status, sections closed at first, no inline hex colours. Read it before any
change to how a screen looks.

Comments here explain *why*, in prose, and are worth keeping — match that.

## The PLC page

A TIA-Portal-shaped programming environment, kept with the project under
`projectData.plc`. Tree on the left, block in the middle, instruction
catalogue or assistant on the right, problems underneath.

**A rung is a tree, never geometry.** LAD and FBD are the ladder model this
app already had (`utils/ladder/model.ts`): groups in series, branches in
parallel, elements in series inside a branch. That is what lets the same
network be drawn, checked, compiled to SCL and handed to a model. A graphical
language stored as free geometry can be none of those. Every edit goes
through `utils/plc/ladderEdit.ts`, whose functions each return a rung that is
still legal — nothing splices a group's branches by hand.

**The reader keeps a half-typed row.** Every edit goes out through the project
and back in through `readPlcProject`, so a row dropped for having no name yet
is a row that cannot be added at all: press Add, get nothing, every time. The
checker says a row is unfinished; the reader does not throw it away.

**Monaco is loaded on demand.** Three megabytes, on one page. `PlcTab` is
`React.lazy` and the editor itself is imported inside `monacoSetup.ts`, so the
main bundle is the size it was. The ESM deep paths (`editor.all`,
`editor.api`) are used rather than the package root, which leaves out eighty
languages and the TypeScript service. Providers are registered **once** — they
are per language, not per editor, and registering them on mount stacks a copy
per block opened.

**Light utilities only, as everywhere else here.** Tailwind's `dark:` variant
is not configured; `theme.css` remaps the light classes under
`[data-theme="dark"]`. Use the tints it names (`bg-blue-50`, `bg-amber-50/60`)
— a slashed tint it does not name stays near-white on a dark page.

**A panel that appears must not move what is under the pointer.** The armed-
instruction strip in the catalogue used to appear only when something was
picked, which pushed the list down between the two clicks of a double click:
picking TON gave a Set coil. It is always on screen now.

**A rung is laid out on one grid, and the numbers must match the markup.**
Every branch of every group shares one set of rows, worked out across the whole
rung — each group stacking its own branches drew the second pair of parallel
contacts at a different height from the first. And every height the layout
states (`LABEL_H`, `BOX_HEAD`, `BOX_BORDER`) has to be a height the markup
states outright: an operand box that came out three pixels shorter than
`LABEL_H` said left every wire meeting every contact three pixels high. There
is a Playwright check for this — measure the wire's centre against the glyph's
centre; it is invisible in a screenshot and obvious on a drawing.

**The ladder stays left to right in Persian.** Current leaves the left rail.
`dir="ltr"` on the ladder, on the code editor and on every address, type and
operand input; the page and its running text turn, the toolbar and the rung do
not. `components/PLC/lang.ts` holds the two languages, `utils/plc/checkLang.ts`
holds what the checker says, and the instruction **names** never turn — only
the description beside them (`titleOf`) and the long help (`helpOf`).

**`TITLE_FA` and `HELP_FA` cover every instruction, and have to stay that way.**
They are lookups at the foot of `utils/plc/instructions.ts`, keyed by id. An id
in one and not the other is an entry that is half in each language, which reads
worse than being in neither — so a new instruction gets both lines in the same
commit. Inside the Persian, the numbers, the pin names, the addresses and the
SCL stay in the form they are typed in. Code columns beside Persian text carry
`dir="ltr"`: the glyph column, the pin line and the SCL block in the catalogue's
help panel all would be drawn backwards without it, because `-| |-` and `-(S)-`
are neutral characters that take the paragraph's direction.

**Nothing here talks to a controller.** The page writes, checks and exports;
it does not claim to produce a file TIA will import unchanged and it does not
download to a rack. The assistant's answers are drafts for an engineer to
read, and the panel says so where the work is handed over.

## Shipping

Push to the working branch. GitHub Actions (`Build simorgh-soft`) builds the
image on any change under `simorgh-agent/simorgh-soft/**`. Then, on the server:

```bash
cd ~/simorgh-chatbot-ekc-deploy && git pull && ./deploy-soft.sh
```

That pulls the one image and recreates the one container — no build, nothing
else restarted. It prints the running commit from `build.json`; check it matches
what was pushed. **Say to hard-refresh (Ctrl+Shift+R)**: the change is in the
frontend bundle, and a cached bundle looks exactly like a failed deploy.

**A menu goes in `MenuBox`.** `src/components/shared/MenuBox.tsx` measures the
menu and moves it up or left to fit. Placing one at the click and leaving it
there puts the commands off the bottom edge of the screen, which reads to
somebody using it exactly like a command that does nothing.

**A template keeps its id.** Its path, its leaf, its parameters and its name
are all edited in place — `moveTemplate` — because the device rows in Device
Selection point at that id. Rebuilding a template to correct one answer
detaches every row built on it.

**EPLAN window macro (.ema).** `utils/cad/ema.ts` writes a sheet as an EPLAN
2.9 window macro: the frame (`emaSkeleton.ts`) is one of the office's own
macros with its names and paths taken out, and every object is written the
way the office's macros write it (O31 line, O34 polyline, O89 rectangle, O30
text). That is a picture to EPLAN. A template's MV cell goes out instead as
EPLAN's own devices (`emaCell.ts`): each device is a copy of one out of the
office's macros (`emaParts.ts` PROTOS), placed so its connection points face
the next device's — the SLD library's own geometry, read out of SLD.sdb
(PINS) — with EPLAN's corners and T-nodes (CONNS) where a line turns or
branches, and no wire drawn: EPLAN autoconnects on insertion. A macro
numbers its libraries in its own order (A1261 is an index into its ESymLib
list) — a copied device must be renumbered to the frame's. Never invent an
object type or attribute: copy it from a macro the office saved.

**A redrawn library symbol is the office's, not one job's.** Redraws used to
live only in `project.symbolOverrides`, so every other project — a new one too
— drew the old symbols and laid the cell out by the old connection points.
Saving a redraw now also saves it to the office library (`/api/symbols`, id
`redraw:<symbol>`, the whole redraw under `override`); the library draws a
symbol from the project's own redraw, else the office's, else the pack
(`OFFICE_REDRAWS` in iecSymbols) — **except that the newer save wins**: every
redraw is stamped `savedAt` (an office one without it takes the server's
`changedOn`), and an office redraw saved after the project's own replaces it.
Otherwise an older project hid every later correction behind its own copy.
An office symbol made with "New variant" from a built-in single-line symbol
**under the same name** ("Ammeter" from Ammeter) counts as the office's redraw
of it (`standsFor` in officeSymbols) — the owner made his corrected symbols
that way and the drawings went on with the old ones. A renamed variant is a
face of its own, chosen per part. "Use in every project" in the symbol library
copies a project's existing redraws to the office. Redraws are kept out of the
office's list of new symbols. The server keeps each terminal's `dir`.



## Working with this owner, and where the work stands

Read this before anything else in a new context window. It is the thread of
the work so far; keep it current when a feature lands or a question closes.

**How the owner works.** Writes in Persian; answer in Persian. Asks for
several things in one message — split them into a task list and do all of
them. "هیچ عملکردی را حذف یا تغییر نده": never drop a capability, even one that
looks redundant — if a change would remove one, keep it behind an option and
say so. Deploy line to give after every push:
`git pull --no-rebase && ./deploy-soft.sh`, then Ctrl+Shift+R. Colours per the
simorgh-ui skill (neutral, blue only for the primary action).

**Testing without the server.**
- Drawings and pure utils: bundle a script with
  `npx esbuild x.ts --bundle --platform=node --format=cjs --define:import.meta.env='{}'`
  (plain `tsx` dies on `import.meta.env` in projectService), write the SVG,
  screenshot it with Playwright.
- A screen that needs the project context: in `src/__preview.tsx` wrap it in
  `ProjectContextProvider` (exported from ProjectContext) with a `Proxy` value
  whose missing keys are no-op functions, mount, drive with Playwright.
  Delete `src/__preview.tsx` and `preview.html` before committing.

**Full screen is one tree.** A screen that returns a different JSX tree when
maximised gets a *new* component instance, and every setting on it (frozen
header/columns/rows, filters, widths, scroll) resets. Change only the frame's
classes (`DeviceSelectionTab`, `SendToEplanTab` do this now).

**What has been built, and where.**
- *Simorgh Draw tab* (`EplanixTab`): one switchgear at a time. Nothing is
  drawn until one is chosen ("All" is for print/export only — never drawn
  together). Single line, layout and mechanical are that switchgear's alone.
- *LV graphic templates*: wizard asks single/multi-line, 1PH+N/3PH/3PH+N, PEN.
  Drawn by the MV cell rules with `opts.lv` (`drawMvCell`), or
  `buildLvMultiLineSvg`. OFW (MOTOR/FEEDER/MODULLAR…): plug-in socket top and
  bottom, breaker not withdrawable (may be motorised). FIX (CCS/OFF/…): no
  sockets, breaker withdrawable. The project sheet draws such feeders exactly
  as their template graphic (`lvCellOf` in `drawSheet`); older LV templates
  keep `drawBranch`, whose instruments are joined point to point (no column
  line through them) and whose labels wrap at `LV_WRAP` 16.
- *Protection/poles*: asked for LV breakers, never written on the drawing; a
  Symbol Library symbol whose name has both ("CB LSIG 4P") is picked for it.
- *Part symbol default*: the slot the part was loaded into decides
  (`slotSymbol` in `symbolForPart`); EPLAN/description only refine within the
  same kind (`REFINES`).
- *SIM-TABLE* is its own layer (`SIMTABLE`), toggled at EPLAN export.
- *Layout* (`utils/layout/`): `s8DrawerTable.ts` is the office's FEEDER
  ASSEMBLY LIST REV 32 (regenerate from the sheet, do not hand-edit);
  `s8Drawers.ts` picks the smallest fitting drawer (frame, amps, poles,
  contactors, SFD/HFD, motor, control-equipment maximum);
  `layoutStandard.ts` is RE-TE-011-01 plus the first duct standard (sides 60,
  MCB rows 40, breaker/contactor rows 60, terminals 80/60, 300 off the floor);
  `layoutPages.ts` draws the S8 front view and the fixed internal view. In the
  page tree: "Layout from project…". `s8Catalogue.ts` is Siemens' SIVACON S8
  Technical Planning Information 10/2015 (busbar ratings, temperature
  factors, ACB cubicle widths, minimum drawer heights); the S8 page is drawn
  like the office's SIMARIS outlines (CELL n, cell.position, position list,
  floor plan). CCS: incomer at the top (B29), width auto with 20 % plate spare
  (B20), twin panel when it does not fit.
- *Offer control equipment*: `TemplateItem.offerControl`, beside the rows
  (never bought, never sent to EPLAN), edited from the template's "Offer
  control" button; sizes the first drawer; Output tab section 06 compares it
  with the design and marks claims.
- *Breaker codes*: SION 3AE5 (`utils/sion3ae5/engine.ts`), 3AH3 (`ah3.ts`),
  SIMOPRIME World/A4/EK36 catalogues, stock conversion (`convert.ts`, tab
  "Stock Compare").

**Open questions — ask before assuming otherwise.**
- Confirmed by the owner: 1M = 50 mm (the catalogue's grid too), and the 2M
  drawer is used.
- Device faces in `faceOf` are rounded from memory of Siemens catalogues.
- LV three-line `.ema`: WD.sdb received (the office's own wiring symbols);
  sample LV three-line macros (.ema) are still needed for PROTOS, as for MV.
- The SIMARIS S8 sample (SAMPLE_1.pdf) is in; the owner will send SIMARIS
  references piece by piece for the details (cell current, double busbar…),
  and the skeleton/drawer layout symbols.
