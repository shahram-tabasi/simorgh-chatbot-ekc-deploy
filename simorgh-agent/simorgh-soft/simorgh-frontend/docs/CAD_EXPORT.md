# CAD export — how a sheet becomes a file

The Eplanix drawings used to be SVG strings built by hand, so SVG (and a PDF of
it, through the print dialog) was the only thing that could come out of them.
They are now built once as geometry and rendered per format, which is what lets
the same sheet leave as a CAD drawing.

```
Device Selection rows + templates
        │
        ├── buildEplanRows()        → Excel device list        → EPLAN import
        │
        └── drawSheet() ─ Drawing ──┬── renderSvg()            → preview, print, PDF
                                    └── renderDxf()            → AutoCAD, BricsCAD,
                                                                 ZWCAD, LibreCAD, QCAD,
                                                                 EPLAN DXF import
```

## The three files

| File | What it is |
|---|---|
| `src/utils/cad/shapes.ts` | `Drawing` and `Shape` — lines, rects, circles, arcs, quadratic curves, polylines and text, on named layers. No output format knows about another. |
| `src/utils/cad/svg.ts` | `renderSvg()` — the screen and print back-end. |
| `src/utils/cad/dxf.ts` | `renderDxf()` — the CAD back-end, plus `mergeDrawings()` for putting several sheets in one file. |

Sheets are drawn in pixels with y downwards, the coordinates the previews always
used. `renderDxf` scales (`mmPerUnit`, default 0.5), flips y, and centres the
result on the smallest ISO landscape sheet it fits, with a border and a title
block.

## Adding a format

Write one function that walks `drawing.shapes` — that is the whole contract.
A vector PDF back-end over `jspdf` (already a dependency) would be the obvious
next one, replacing the print dialog with a real PDF.

## Choices worth knowing

**DXF R12 (AC1009).** The most widely readable dialect: no handles, no object
dictionary, entities every reader since 1990 understands. Curves are flattened
to line segments, filled triangles become `SOLID`, and arcs, circles, lines and
text stay what they are.

**Layers, not colours.** `BUS`, `WIRE`, `SYMBOL`, `TAG`, `TEXT`, `TABLE`,
`PANEL`, `SLOT`, `FREE`, `FRAME`, `TITLE`, `LOAD`. The SVG keeps its own
colours; CAD takes colour from the layer, so a drawing office can switch a whole
class of geometry off.

**Text.** R12 predates UTF-8, so non-ASCII is written as `\U+00E7`, which
AutoCAD and BricsCAD render correctly. Punctuation the sheets use as separators
(`—`, `·`, `×`, `…`) is folded to ASCII first so it does not survive as an
escape; letters in Turkish and Persian names are escaped, not folded. Pass
`unicode: 'raw'` for readers that prefer UTF-8 bytes.

## On the symbols

The symbol geometry in `drawSymbol()` is drawn here, line by line and arc by
arc, to the IEC 60617 conventions. No vendor symbol library is copied, which is
what makes it ours to ship in any format we like — including DXF, where the
geometry is the deliverable rather than a picture of it.
