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

The Edit tab opens the sheet on a canvas. Because the sheet is geometry rather
than a string, everything a drawing office expects is only a function away:

- **Pick** — click a shape, shift-click to add, or drag a band round several.
  Picking is done against the geometry, not by hanging a handler on every
  element, so a 1.3-unit line is as easy to hit as a filled box.
- **Move** — drag, or nudge with the arrow keys; both snap to the chosen step.
- **Retype** — double-click a label, or edit it in the panel.
- **Layers** — hide or lock a class of geometry: the busbar, the tags, the data
  block.
- **Undo** — a step is a whole array of shapes, shared structurally, so a
  hundred steps of a 700-shape sheet cost a hundred arrays of pointers.
- **Export** — DXF, PDF and SVG all read the edited shapes, so what leaves is
  what is on the screen.

Edits are held per sheet and per session; nothing is written back to the project
data. Revert puts a sheet back to as drawn.

## Choices worth knowing

**DXF R12 (AC1009).** The most widely readable dialect: no handles, no object
dictionary, entities every reader since 1990 understands. Curves and ellipses
are walked as line segments — R12 has no `ELLIPSE` and no spline — while arcs,
circles, lines and text stay what they are.

**Layers.** `BUS`, `WIRE`, `SYMBOL`, `TAG`, `TEXT`, `TABLE`, `PANEL`, `SLOT`,
`FREE`, `FRAME`, `TITLE`, `LOAD`. A shape's layer comes from a `data-layer`
attribute when the drawing code sets one, and otherwise is read off how the
shape is drawn — a 5-unit stroke is the busbar, bold text is a device tag.
Emitting `data-layer` from the sheet code would make it exact, and needs no
change on this side.

**Scale.** `mmPerUnit`, 0.5 by default: text lands at about 4 mm and a sheet of
eight feeders comes out around 1.6 m wide, which is a roll plot rather than an
A-size one. Drop it to 0.25 to put the same sheet on an A1.

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

## Adding a format

Write one function that walks `drawing.shapes` — that is the whole contract.

## On the symbols

The symbol geometry in `iecSymbols.ts` is drawn in this repository, line by line
and arc by arc, from the office's own legend sheet. No vendor symbol library is
copied — which is what makes it ours to ship in any format we like, including
DXF, where the geometry itself is the deliverable rather than a picture of it.
