// src/utils/cad/replaceSymbol.ts
//
// A symbol redrawn, on the sheets it is already drawn on.
//
// Redrawing a symbol changes what the library hands out, and that was all it
// changed: the pages already drawn held the old picture as plain geometry — a
// dozen lines and arcs that had stopped being a symbol the moment they landed
// — so the breaker on sheet 3 kept the drawing the office had just decided was
// wrong. "I edited it and it is not applied in the project" is exactly that,
// and no amount of saving fixes it, because nothing on the page knew which
// symbol those lines had been.
//
// Now they do. A symbol placed from the library carries its id on every shape
// (`Pen.symbol`), so the ones already on a sheet can be found again and the new
// drawing put in their place. Blocks placed before this existed carry only the
// symbol's name, which is what `blockName` is, so that is matched too — it is
// the same symbol under the same name, and the alternative is a project that
// can never be brought up to date.
//
// What is kept when one replaces the other:
//
//   * **the conductor.** A single-line symbol is drawn around the branch line,
//     and the line runs through `pinX`. The new drawing is placed so its own
//     pin lands exactly where the old one's was — so a symbol that grew a
//     racking arm to the left grows it to the left of the same wire rather
//     than dragging the wire with it.
//   * **the height on the line.** One cell is one cell: the replacement is
//     scaled so it stands as tall as what it replaces, and keeps its own
//     proportions across.
//   * **the block.** Same id, same name, so what was one object stays one
//     object and every wire still ends where it ended.
//
// What cannot be kept is a turn: nothing on the page records that an instance
// was rotated or mirrored after it was placed, so one that was comes back the
// way the library draws it. The screen that offers this says so before it
// does anything, because a silent straightening is worse than a refusal.

import { boundsOfAll } from './edit';
import { mapShape, scaling, translation } from './geom';
import { Shape } from './shapes';

/** One version of a symbol: its geometry, and where the conductor runs in it. */
export interface SymbolArt {
  /**
   * Everything the instance is made of — the ink *and* its connection points.
   *
   * The points belong in here rather than beside it because they have to go
   * through the same scale and the same move as the ink. A replacement put
   * down without them is a device that looks right and cannot be wired: the
   * wires on the sheet still end where they ended, and there is no longer
   * anything there for them to end *on*, so the connection list goes quiet.
   */
  shapes: Shape[];
  /** The conductor's x in the geometry's own coordinates. */
  pinX: number;
}

/**
 * The ink of a symbol — everything that is not a connection point.
 *
 * One function rather than three copies of the same filter, because the whole
 * of the arithmetic below depends on the three boxes it measures being
 * measured alike.
 */
const inkOnly = (run: Shape[]): Shape[] => run.filter(sh => !sh.pin);

/** Every shape of `shapes` that was placed from this symbol, by block. */
function instances(
  shapes: Shape[], symbolId: string, name: string,
): Map<string, number[]> {
  const by = new Map<string, number[]>();
  shapes.forEach((s, i) => {
    if (!s.block) return;
    const mine = s.symbol
      ? s.symbol === symbolId
      // Placed before symbols were stamped with their id: the name is all
      // there is, and it is the name the library placed it under.
      : Boolean(name) && s.blockName === name;
    if (!mine) return;
    const list = by.get(s.block);
    if (list) list.push(i); else by.set(s.block, [i]);
  });
  return by;
}

/** How many places on this sheet this symbol is drawn. */
export function countInstances(shapes: Shape[], symbolId: string, name: string): number {
  return instances(shapes, symbolId, name).size;
}

/**
 * `shapes` with every instance of this symbol redrawn as `to`.
 *
 * `from` is the version being replaced — needed, not merely informative: it is
 * what says where the conductor was in the drawing that is on the page, and so
 * where the new one has to be put for the symbol to stay on its wire.
 */
export function replaceSymbolInstances(
  shapes: Shape[],
  symbolId: string,
  name: string,
  from: SymbolArt,
  to: SymbolArt,
): { shapes: Shape[]; count: number } {
  const found = instances(shapes, symbolId, name);
  if (found.size === 0) return { shapes, count: 0 };

  // **Every box here is measured the same way: on the ink, never on the
  // connection points.** That is not a detail. The instance on the sheet is
  // measured below against these two, and a box measured one way compared with
  // a box measured the other is a difference that turns into a shift — the
  // symbol lands a little to the side, and a little further every time it is
  // redrawn, until it is off its wire. A connection point is a ring drawn on
  // the edge of a symbol with half of it hanging outside, so including them
  // would be exactly that mismatch.
  const fromBox = boundsOfAll(inkOnly(from.shapes));
  const toBox = boundsOfAll(inkOnly(to.shapes));
  if (!fromBox || !toBox || toBox.h <= 0 || fromBox.h <= 0) return { shapes, count: 0 };

  // Where the two versions keep the conductor inside their own boxes.
  const fromPin = from.pinX - fromBox.x;
  const toPin = to.pinX - toBox.x;

  const out: Shape[] = [];
  const done = new Set<string>();
  let count = 0;

  shapes.forEach((s, i) => {
    const block = s.block ?? '';
    const group = found.get(block);
    if (!group || !group.includes(i)) { out.push(s); return; }
    // The whole block is rewritten where its first shape stood, so the order
    // of what is around it on the sheet is left alone.
    if (done.has(block)) return;
    done.add(block);

    // The instance's ink, measured the same way as the two drawings above.
    const mine = group.map(j => shapes[j]);
    const ink = inkOnly(mine);
    const placed = boundsOfAll(ink.length ? ink : mine);
    if (!placed || placed.h <= 0) { group.forEach(j => out.push(shapes[j])); return; }

    // As tall as what it replaces, and its own shape across.
    const k = placed.h / fromBox.h;
    const pinAt = placed.x + fromPin * k;

    const sized = to.shapes.map(sh => mapShape(sh, scaling(toBox.x, toBox.y, k)));
    const dx = pinAt - (toBox.x + toPin * k);
    const dy = placed.y - toBox.y;

    for (const sh of sized) {
      out.push({
        ...mapShape(sh, translation(dx, dy)),
        block,
        blockName: s.blockName ?? name,
        symbol: symbolId,
      });
    }
    count += 1;
  });

  return { shapes: out, count };
}
