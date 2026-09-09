# CAD export — how a sheet becomes a DXF

The EPLAN customer gets the device list and the add-in. Everybody else — and
that is most of the market outside a plant that has already bought EPLAN — gets
DXF: Autodesk's published interchange format, which opens and edits in AutoCAD,
BricsCAD, ZWCAD, LibreCAD, QCAD, and in EPLAN's own DXF import.

```
Device Selection rows + templates
        │
        ├── buildEplanRows()      → Excel device list         → EPLAN import
        │
        └── drawSheet() ─ SVG ────┬── preview, print, PDF
                                  │
                                  └── drawingFromSvg() ─ Drawing ── renderDxf()
                                                                        → .dxf
```

## Why the SVG is read back rather than drawn twice

The sheet is drawn once, as SVG, by `iecSymbols.ts` and `eplanSingleLine.ts` —
and that code is under active development: symbols get added, instruments move
beside the line, MV cells get their own order. A second geometry pass beside it
would go stale within a week and would collide with every change made there.

So the CAD export reads the SVG the sheet already produced and turns it back
into geometry. Nothing in the drawing code changes, nothing has to be kept in
step, and every symbol the library gains reaches DXF the day it is drawn.

The conversion is lossless for what the sheets emit: SVG → `Drawing` → SVG
renders **pixel-identical** to the original, verified in Chromium across an LV
board of twelve feeders over two sheets and an MV board of four cells.

## The files

| File | What it is |
|---|---|
| `src/utils/cad/shapes.ts` | `Drawing` and `Shape` — lines, rects, circles, ellipses, arcs, quadratic curves, polylines and text, on named layers. |
| `src/utils/cad/fromSvg.ts` | `drawingFromSvg()` — a finished sheet read back as geometry, using the browser's own `DOMParser`. |
| `src/utils/cad/dxf.ts` | `renderDxf()` — DXF R12, plus `mergeDrawings()` for several sheets in one file. |
| `src/utils/cad/sheetDxf.ts` | `sheetsToDxf()` — the two joined up, which is what the tab calls. |
| `src/utils/cad/svg.ts` | `renderSvg()` — the other direction. The panel layout draws through it, and it is what makes the round-trip test possible. |

Sheets are drawn in pixels with y downwards. `renderDxf` scales (`mmPerUnit`,
default 0.5), flips y, and centres the result on the smallest ISO landscape
sheet it fits, with a border and a title block.

## Choices worth knowing

**DXF R12 (AC1009).** The most widely readable dialect: no handles, no object
dictionary, entities every reader since 1990 understands. Curves and ellipses
are walked as line segments — R12 has no `ELLIPSE` and no spline — while arcs,
circles, lines and text stay what they are.

**Layers.** `BUS`, `WIRE`, `SYMBOL`, `TAG`, `TEXT`, `TABLE`, `PANEL`, `SLOT`,
`FREE`, `FRAME`, `TITLE`, `LOAD`. A shape's layer comes from a `data-layer`
attribute when the drawing code sets one, and otherwise is read off how the
shape is drawn — a 5-unit stroke is the busbar, bold text is a device tag. That
is enough for what a drawing office does with layers: switch a class of
geometry off. Emitting `data-layer` from the sheet code would make it exact,
and needs no change here.

**Text.** R12 predates UTF-8, so non-ASCII is written as `\U+00E7`, which
AutoCAD and BricsCAD render correctly. Punctuation the sheets use as separators
(`—`, `·`, `×`, `…`) is folded to ASCII first so it does not survive as an
escape; letters in Turkish and Persian names are escaped, not folded. Pass
`unicode: 'raw'` for readers that prefer UTF-8 bytes.

**Picture symbols.** A symbol supplied through the symbol pack as an image file
has no R12 equivalent. Its cell is marked with a dashed box rather than dropped,
so the drawing says something is there.

## Adding a format

Write one function that walks `drawing.shapes` — that is the whole contract. A
vector PDF back-end over `jspdf` (already a dependency) is the obvious next one,
replacing the print dialog with a real PDF.

## On the symbols

The symbol geometry in `iecSymbols.ts` is drawn in this repository, line by line
and arc by arc, from the office's own legend sheet. No vendor symbol library is
copied — which is what makes it ours to ship in any format we like, including
DXF, where the geometry itself is the deliverable rather than a picture of it.
