# Simorgh Draw — from a sheet to a file, and back

The EPLAN customer gets the device list and the add-in. Everybody else — most
of the market outside a plant that has already bought EPLAN — gets a drawing
they can open, edit and plot: DXF for CAD, PDF for issue, SVG for the web.

```
Device Selection rows + templates
        │
        ├── buildEplanRows()      → Excel device list          → EPLAN import
        │
        └── drawSheet() ─ SVG ────┬── preview · Print / PDF
                                  │
                                  └── drawingFromSvg() ─ Drawing ─┬── the editor
                                                                  ├── renderDxf()
                                                                  ├── renderPdf()
                                                                  └── renderSvg()
```

## Why the SVG is read back rather than drawn twice

The sheet is drawn once, as SVG, by `iecSymbols.ts` and `eplanSingleLine.ts` —
and that code is under active development. A second geometry pass beside it
would go stale within a week and would collide with every change made there.

So the CAD side reads the SVG the sheet already produced and turns it back into
geometry. Nothing in the drawing code changes, nothing has to be kept in step,
and every symbol the library gains reaches DXF, PDF and the editor the day it is
drawn.

The conversion is lossless for what the sheets emit: SVG → `Drawing` → SVG
renders **pixel-identical** to the original, verified in Chromium across an LV
board of twelve feeders over two sheets and an MV board of four cells.

## The files

| File | What it is |
|---|---|
| `utils/cad/shapes.ts` | `Drawing` and `Shape` — lines, rects, circles, ellipses, arcs, quadratic curves, polylines and text, on named layers. |
| `utils/cad/fromSvg.ts` | `drawingFromSvg()` — a finished sheet read back as geometry, through the browser's own `DOMParser`. |
| `utils/cad/paper.ts` | Scale, sheet size and margin — the part every output format agrees on. |
| `utils/cad/dxf.ts` | `renderDxf()` — DXF R12, plus `mergeDrawings()`. |
| `utils/cad/pdf.ts` | `renderPdf()` — vector PDF over jsPDF, a page per sheet. |
| `utils/cad/svg.ts` | `shapeToNode()` and `renderSvg()` — markup for a file, React elements for the editor, one definition of the geometry. |
| `utils/cad/edit.ts` | Move, delete, duplicate, retype, hit test, rubber band, undo. Pure functions over an array of shapes. |
| `components/SimorghDraw/` | The editor: `DrawingCanvas` draws and picks, `DrawingEditor` is the tools, layers and exports around it. |

## The editor

Editing starts from the drawing, not from a tab of its own. On the single line,
**Edit drawing — ویرایش نقشه** — or a double-click on the sheet — opens that
switchgear's sheets in a window over the page they belong to, and closing it
puts you back where you were. The same editor opens on one library symbol from
a card in **Symbols**, and on a whole template from the template page, so the
tool is the same wherever a drawing is looked at.

Because the sheet is geometry rather than a string, everything a drawing office
expects is only a function away:

- **Pick** — click a shape, shift-click to add, or drag a band round several.
  Picking is done against the geometry, not by hanging a handler on every
  element, so a 1.3-unit line is as easy to hit as a filled box.
- **Move** — drag, or nudge with the arrow keys; both snap to the chosen step.
- **Handles** — a picked shape shows grips. A **square** moves that point on
  its own, so a line is shortened from the end you took hold of rather than
  from whichever end the code fancies; the **diamond** in the middle carries
  the whole shape. Every kind has them: a rectangle by its corners, a circle by
  its radius, an arc by its ends, a polyline by every vertex. The magnet still
  applies, Shift still squares the line up against its other end, and the
  length and angle follow the cursor while a handle is in hand — the same
  readout, in the same place, as EPLAN's. A whole drag is one undo step,
  however far the pointer travelled.
- **Exact numbers** — the Selection panel shows the picked shape as numbers, in
  millimetres: start, end, length, angle for a line; centre and radius for a
  circle; and so on. All of them can be typed, which is how a line goes from
  about right to exactly 111.00 mm. Length and angle hold the first end and
  swing the second, so a line can be given a size without first working out
  where its far end would have to be. Polylines and curves show their point
  count instead — typing thirty vertices is data entry, not editing, and the
  handles are the way to move those.
- **Retype** — double-click a label, or edit it in the panel.
- **Draw** — line, polyline, rectangle, circle, ellipse, arc, text and
  dimension, each on the toolbar under one letter: `V` pick, `H` pan, `L` line,
  `P` polyline, `R` rectangle, `C` circle, `E` ellipse, `A` arc, `T` text,
  `D` dimension. Two clicks make a line, or drag it in one; a polyline ends on
  Enter, a right-click or a double-click, and Backspace takes its last point
  back; an arc is centre, start, then sweep. Escape drops what is half-drawn,
  and a right-click with nothing half-drawn ends the command — both the way
  every CAD package behaves.
- **Cut and join** — `X` trim cuts a line back to whatever crosses it (click
  the piece to lose); `W` extend runs a line on to the first thing in its way;
  `K` corner brings two lines to where they would meet, cutting or extending
  each as it needs. Give corner a radius and it rounds instead: the lines stop
  at the tangent points and an arc joins them. All three refuse anything but a
  straight line, and say so rather than doing something unexpected.
- **Change what is there** — turn by 90° either way or by a typed angle,
  mirror left-to-right or top-to-bottom, scale by a factor, align six ways,
  even out the gaps across or down, and bring to front or send to back. All of
  them work on whatever is picked, about the middle of it.
- **Dimension** — three clicks: from, to, and where the line sits. It goes down
  as ordinary geometry — extension lines, the dimension line, two filled
  arrowheads and a label written in millimetres of real size — so every
  back-end carries it without a new case, which is what R12 would demand
  anyway. The number is measured once, when it is placed.
- **Snap** — the magnet picks up the ends, middles, centres and corners of what
  is already there, so a new line meets the drawing rather than nearly meets it.
  Holding Shift keeps a line level, upright or on 45°. With the magnet off,
  points fall on the grid step instead.
- **Style** — layer, line weight, line type (solid, dashed, dash-dot, dotted)
  and text height sit on their own bar. They set up what is drawn next, and
  with something picked they restyle it, the way a CAD system does. The same
  four appear in the **Selection** panel, where clicking a line and putting its
  weight right is one gesture rather than a trip back up to the bar. A mixed
  selection shows a dash rather than a value it does not have, and changes only
  what it is told to.
- **Layers** — hide or lock a class of geometry: the busbar, the tags, the data
  block. New geometry takes the colour of the layer it goes on.
- **Full screen** — the whole window for the drawing, on the toolbar or Esc to
  leave. The Fullscreen API where the browser allows it, and a window-filling
  fallback where it does not, so the button always does something.
- **Three languages** — English, Persian and Turkish, switched on the toolbar
  and remembered in the browser, because the language belongs to the person and
  not to the project. The toolbar keeps its left-to-right order in all three: a
  CAD toolbar is a row of pictures rather than a sentence, and every package a
  draughtsman here has used runs it the same way round. Only the running text —
  panels, hints, help — turns for Persian.
- **Help** — `F1`, or the `?` on the bar, opens a panel over the canvas: what
  each tool takes, what the keys do, and what is worth knowing. Short enough to
  read standing up, because the question a draughtsman has mid-line is "which
  click ends this", and an answer that costs them the line is not an answer.
  The long version is `public/help-drawing.html`, reached from Help in the
  menu bar and from the foot of the panel — the same three languages, with the
  trim, corner and dimension cases drawn rather than described.
- **Undo** — a step is a whole array of shapes, shared structurally, so a
  hundred steps of a 700-shape sheet cost a hundred arrays of pointers.
- **Export** — DXF, PDF and SVG all read the edited shapes, so what leaves is
  what is on the screen.

**Edits are kept with the project.** Save hands them to `ProjectData.drawingEdits`
and the ordinary project save writes them out, so a corrected sheet is still
corrected tomorrow and for whoever opens the project next. Revert puts one sheet
back to as drawn; Discard all does it for the set, in the project too.

What is stored is the sheet itself — the whole array of shapes, not a list of
changes — because an edited sheet is a document, and a document that quietly
redraws itself underneath its own corrections is worse than one that does not
move. The key is `switchgearId#feedersPerSheet#sheetIndex`, so changing the
feeders per sheet repaginates into different keys and leaves the old edits
alone rather than dropping them onto sheets they were never made against.

Each entry also records what the sheet looked like when it was edited. When the
project changes underneath it, the fingerprint stops matching and the status bar
says which sheets were edited against an older drawing. Saving re-stamps only
the sheets touched in that session: saving one sheet must not vouch for another.

A view-only revision cannot keep edits, and the Save button says so.

## Choices worth knowing

**DXF R12 (AC1009).** The most widely readable dialect: no handles, no object
dictionary, entities every reader since 1990 understands. Curves and ellipses
are walked as line segments — R12 has no `ELLIPSE` and no spline — while arcs,
circles, lines and text stay what they are.

**Text rotation survives the trip.** A label turned in the editor — up the side
of a column, along a slant dimension — carries its angle into all three
back-ends: SVG as a `rotate()` about the anchor, DXF as group 50 on the `TEXT`
entity, PDF as jsPDF's own angle. Sheet space measures y downwards while all
three of those measure a label anticlockwise on the paper, so `Shape.rot` is
defined the paper's way and `cad/geom.ts` negates it once, in the one place a
turn is described.

**Line types survive the trip.** A dashed line drawn here is a dashed line in
the customer's CAD system: `lineTypeFor` reads the SVG dash pattern back to
`DASHED`, `DASHDOT` or `DOT`, and the entity carries that name. It is read by
the shape of the pattern rather than by matching exact numbers, so geometry that
arrived from someone else's DXF or SVG keeps its line type as well. All four are
written into the `LTYPE` table whether or not the sheet uses them, so a line
restyled in the CAD system afterwards has something to be restyled to. A shape
with no dash says nothing and takes its layer's line type, as before.

**Layers.** `BUS`, `WIRE`, `SYMBOL`, `TAG`, `TEXT`, `TABLE`, `PANEL`, `SLOT`,
`FREE`, `FRAME`, `TITLE`, `LOAD`. A shape's layer comes from a `data-layer`
attribute when the drawing code sets one, and otherwise is read off how the
shape is drawn — a 5-unit stroke is the busbar, bold text is a device tag.
Emitting `data-layer` from the sheet code would make it exact, and needs no
change on this side.

**Paper and scale.** Two ways of making the same decision. Leave the paper on
*fit the drawing* and `mmPerUnit` (0.5) fixes the scale while the sheet grows —
eight feeders come out about 1.6 m wide, a roll plot. Name a sheet instead and
the scale is whatever fits it, which is how a drawing office works when the
paper is what it has.

Naming a small sheet shrinks the text with everything else, so the number that
matters is what a label plots at. A device label is 9 units:

| feeders / sheet | A4 | A3 | A2 | A1 |
|---|---|---|---|---|
| 2 | **2.1 mm** | 3.0 | 4.4 | 6.2 |
| 3 | 1.7 | **2.4** | 3.5 | 5.0 |
| 4 | 1.4 | **2.0** | 2.8 | 4.0 |
| 6 | 1.0 | 1.4 | **2.0** | 2.9 |
| 8 | 0.8 | 1.1 | 1.6 | **2.3** |

Below about 1.8 mm a plot stops being readable, so an A4 holds two feeders, an
A3 four, an A2 six, an A1 eight. Both the export bar and the editor say what
the current choice comes to and mark it when it falls under that.

**Text in DXF.** R12 predates UTF-8, so non-ASCII is written as `\U+00E7`,
which AutoCAD and BricsCAD render correctly. Punctuation the sheets use as
separators (`—`, `·`, `×`, `…`) is folded to ASCII first so it does not survive
as an escape; letters in Turkish and Persian names are escaped, not folded.

**Text in PDF.** The standard PDF fonts are encoded WinAnsi, which covers
Latin-1. Turkish reaches past it for ğ, ş, ı and İ, and those are folded to
their base letters — one unfolded letter would otherwise flip the whole string
to a two-byte encoding the font cannot map, turning a project name into
nonsense. Persian cannot be set this way at all: it needs its letters joined and
run right to left, which is shaping, and a PDF writer does not shape. Those runs
are marked rather than mangled, and Print / PDF, which renders through the
browser, stays the exact route for a drawing that carries them.

**Picture symbols.** A symbol supplied through the symbol pack as an image file
has no R12 equivalent. Its cell is marked with a dashed box rather than dropped,
so the drawing says something is there.

## The parts table

Not a drawing, but the same problem: nine columns, so a part number reads
`3RV2321-4…` and a description not at all.

`PartCell` gives each cell two ways out, both of which a spreadsheet has and
neither of which costs the table any width. **Hover** puts the whole value in a
tooltip — enough to *read* a cell. **Click** opens a 420px box over it, headed
with the column's name, with room for several lines where the value is long.

Every keystroke in the box goes straight into the row, exactly as typing in the
cell always did. Nothing is staged, so closing is not a decision: Enter, Escape
and a click anywhere else all just close it.

The box is drawn through a **portal to `document.body`**. The table scrolls
sideways inside a box that clips what overflows it, and a panel positioned
inside that box gets its head cut off — which is what happened the first time.
A portal escapes every clipping ancestor there is. The cost is that the position
is measured rather than inherited, so a scroll closes the box instead of
dragging it away from the cell it belongs to.

## Bringing in your own schematics

`utils/cad/readDxf.ts` reads a DXF back into geometry — the other direction
from `dxf.ts`. A device drawn once in AutoCAD and saved as DXF becomes a symbol
on the single line: lines, arcs and text, not a picture, so it goes back out to
DXF and PDF as geometry that can be edited and plots sharp at any scale.

What it reads is what CAD packages write for a symbol: LINE, CIRCLE, ARC,
ELLIPSE, LWPOLYLINE and POLYLINE (bulges included, as real arcs), TEXT, MTEXT,
SOLID, POINT, and blocks placed by INSERT with their own scale and rotation.
Anything else is counted and reported rather than dropped silently.

**Connection points are the wiring.** EPLAN knows where a symbol's conductor
enters and leaves because its symbols say so; a plain DXF does not. The
convention here is a layer named `CONN`, `CONNECTION`, `PIN` or `TERMINAL`
carrying a point at each terminal. Those are read, not drawn, and the symbol is
normalised so its top terminal sits at the top of its box and its bottom
terminal at the bottom — which is what the library already expresses as `pinX`
and `cells`, so the device lands on the branch and the line joins it with
nothing to place by hand.

Without that layer the geometry's own outline is used: conductor through the
middle, top to bottom. It draws correctly; it is a guess about where the
terminals are, and the panel says so.

A file named after one of the library's symbols — `vcb.dxf`,
`current-transformer.dxf` — takes that symbol's place. A file named after the
device instead is loaded all the same and pointed at the right symbol in the
panel, which is the ordinary case.

**Two ways in, and they layer.** A file dropped into the symbol pack on the
server — `simorgh-backend/eplan-symbols/circuit-breaker.dxf` — reaches everyone
who opens the project: the pack endpoint lists it, the app fetches it and reads
it into geometry, and its box, conductor, cells and terminals all come out of
the drawing rather than out of a `data-pin-x` somebody had to measure. That is
where a schematic belongs once it is settled. A file picked in the Symbols tab
is read in that browser only, on top of the pack, which is what you want while
a drawing is still being got right. `eplan-symbols/README.md` is the reference
for both.

A symbol reaches the pack either way: copy the file into the folder, or press
**Send to the pack** in the Symbols tab, which posts it to
`POST /api/eplan-symbols/upload` under the name of the library symbol it
replaces. The route only ever writes — there is no delete, on purpose: a symbol
is taken out of the pack by removing the file, deliberately, by someone who can
see the folder. Names are checked rather than repaired, hidden and half-written
files are never listed, and the file is written beside its place and moved in,
so a browser asking for it mid-upload never gets half of one.

That needs the pack folder mounted writable, which it now is in
`compose/soft-app.yml`. Put `:ro` back to close it off: reads are unchanged and
the upload answers with the reason rather than appearing to work.

## Adding a format

Write one function that walks `drawing.shapes` — that is the whole contract.

## On the symbols

The symbol geometry in `iecSymbols.ts` is drawn in this repository, line by line
and arc by arc, from the office's own legend sheet. No vendor symbol library is
copied — which is what makes it ours to ship in any format we like, including
DXF, where the geometry itself is the deliverable rather than a picture of it.
