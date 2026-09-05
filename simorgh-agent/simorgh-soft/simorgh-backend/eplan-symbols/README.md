# EPLAN symbols

Drop symbols exported from EPLAN here as **SVG**, named after the symbol
itself — `SG3.svg`, `K1.svg`, `T1.svg`. The single line in the Eplanix tab
draws those instead of its own symbol for every part whose EPLAN function
template names them, so the drawing carries the office's own graphics.

Exporting from EPLAN: open the symbol in the symbol editor (or place it on a
page), then *Page → Export → Image file* / *File → Export → DXF/SVG*, and save
it under the symbol's name. Anything not exported here is drawn by the app,
from what EPLAN says the part is.

The folder is mounted read-only into the container at `/app/eplan-symbols`
(`EPLAN_SYMBOL_DIR`), so adding a symbol is a copy — no rebuild.
