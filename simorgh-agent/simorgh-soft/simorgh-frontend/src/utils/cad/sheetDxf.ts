// src/utils/cad/sheetDxf.ts
//
// The CAD half of the single line: the sheets the app already drew, written
// out as one DXF file.
//
// This is the output for a customer who has no EPLAN. The EPLAN customer gets
// the device list and the add-in; everybody else gets a drawing that opens and
// edits in AutoCAD, BricsCAD, ZWCAD, LibreCAD or QCAD — real geometry on real
// layers, not a picture.
import { Drawing } from './shapes';
import { drawingFromSvg } from './fromSvg';
import { renderDxf, mergeDrawings, DxfOptions } from './dxf';

/** The sheets of one drawing set, tiled left to right in a single file. */
export function sheetsToDrawing(sheets: string[], name = ''): Drawing {
  if (sheets.length === 0) return new Drawing(100, 100, name);
  const drawings = sheets.map((svg, i) =>
    drawingFromSvg(svg, sheets.length > 1 ? `${name} ${i + 1}/${sheets.length}` : name));
  return drawings.length === 1 ? drawings[0] : mergeDrawings(drawings, 60, name);
}

/** Those sheets as a DXF file. */
export function sheetsToDxf(
  sheets: string[],
  titleBlock: string[] = [],
  name = '',
  options: DxfOptions = {},
): string {
  return renderDxf(sheetsToDrawing(sheets, name), { titleBlock, ...options });
}
