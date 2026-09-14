// Asking the local model to draw.
//
// The model writes shapes as JSON and this file decides what of it reaches the
// sheet. That split is the whole design: a language model is good at "an
// isolator above a fuse above a motor, wired down the middle" and bad at
// arithmetic, so it is given the vocabulary and the page, and everything it
// hands back is checked before anything is drawn.
//
// Nothing here trusts the model. Every shape is validated field by field
// against the same Shape union the editor uses, coordinates are clamped to the
// sheet, layers are forced to the known set, and anything that does not survive
// is dropped and counted rather than repaired into something plausible — a
// silently "fixed" line in a schematic is worse than a missing one, because
// nobody looks at it again.

import { stripReasoning } from './chatModel.js';

/** The layers a generated drawing may use, and what each is for. */
const LAYERS = {
  SYMBOL: 'device symbols',
  WIRE: 'connections between devices',
  BUS: 'busbars',
  TAG: 'device designations and wire numbers',
  TEXT: 'notes, ratings, descriptions',
  LOAD: 'motors and outgoing arrows',
};

/** Line types, by the dash pattern the editor already understands. */
const DASHES = { solid: undefined, dashed: '6 4', 'dash-dot': '10 3 2 3', dotted: '1.5 3' };

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * The instructions the model works to.
 *
 * Deliberately narrow: a short vocabulary it can hold in mind beats a complete
 * one it half-remembers. Every rule here exists because its absence produces a
 * drawing an electrician would reject — diagonal wires, symbols drawn as
 * free-floating strokes with nothing tying them together, text with no size.
 */
function systemPrompt({ width, height, textSize }) {
  return [
    'You draw electrical schematics as JSON. Answer with JSON only, no prose.',
    '',
    `The sheet is ${width} by ${height} units, x to the right, y DOWNWARDS from the top-left.`,
    'Keep everything inside the sheet with a margin of at least 20 units.',
    '',
    'Answer with: {"shapes":[...],"note":"one short sentence"}',
    '',
    'Each shape is one of:',
    '  {"t":"line","x1":N,"y1":N,"x2":N,"y2":N,"layer":L}',
    '  {"t":"rect","x":N,"y":N,"w":N,"h":N,"layer":L}',
    '  {"t":"circle","cx":N,"cy":N,"r":N,"layer":L}',
    '  {"t":"arc","cx":N,"cy":N,"r":N,"a0":DEG,"a1":DEG,"layer":L}',
    '  {"t":"poly","pts":[[x,y],...],"layer":L}',
    `  {"t":"text","x":N,"y":N,"s":"...","size":${textSize},"layer":L}`,
    '',
    `layer is one of: ${Object.entries(LAYERS).map(([k, v]) => `${k} (${v})`).join(', ')}.`,
    'Optional on any shape: "dash" as one of solid, dashed, dash-dot, dotted.',
    '',
    'Rules:',
    '1. Wires run horizontally or vertically only. Never diagonal. To get from',
    '   one place to another, use a poly that turns at right angles.',
    '2. Every shape making up one device carries the same "block" string and the',
    '   same "blockName" (what the device is, e.g. "CONTACTOR"). This is what',
    '   makes it one object rather than loose strokes.',
    '3. Give each device a designation as a text on the TAG layer just above it:',
    '   -Q1 for breakers and isolators, -K1 contactors, -F1 fuses and overloads,',
    '   -M1 motors, -T1 transformers, -P1 meters. Number upwards from 1.',
    '4. Leave the symbols simple: a rectangle, a circle and a few lines read',
    '   better on a schematic than a detailed picture.',
    '5. Power flows down the page: supply at the top, load at the bottom.',
  ].join('\n');
}

/**
 * Keep what is valid, drop what is not, and say which.
 *
 * `bounds` is the sheet. A shape reaching outside it is clamped rather than
 * dropped — the model is usually right about what to draw and wrong about
 * where by a little — but a shape missing a coordinate altogether is dropped,
 * because there is no honest way to guess at it.
 */
function validateShapes(raw, bounds) {
  const { width, height, textSize } = bounds;
  const shapes = [];
  const dropped = [];
  const clamp = (v, hi) => Math.max(0, Math.min(hi, v));
  const cx = v => clamp(v, width);
  const cy = v => clamp(v, height);

  if (!Array.isArray(raw)) return { shapes, dropped: ['the model did not return a list of shapes'] };

  raw.forEach((s, i) => {
    if (!s || typeof s !== 'object') { dropped.push(`#${i}: not an object`); return; }

    const layer = typeof s.layer === 'string' && LAYERS[s.layer.toUpperCase()]
      ? s.layer.toUpperCase() : 'SYMBOL';
    const pen = { layer };
    if (typeof s.dash === 'string' && s.dash in DASHES && DASHES[s.dash]) pen.dash = DASHES[s.dash];
    // A block is only meaningful with a name, and vice versa: half of the pair
    // makes a shape that is grouped with nothing, which is worse than loose.
    if (typeof s.block === 'string' && s.block && typeof s.blockName === 'string' && s.blockName) {
      pen.block = s.block.slice(0, 64);
      pen.blockName = s.blockName.slice(0, 64);
    }

    switch (s.t) {
      case 'line': {
        const [x1, y1, x2, y2] = [num(s.x1), num(s.y1), num(s.x2), num(s.y2)];
        if (x1 === null || y1 === null || x2 === null || y2 === null) {
          dropped.push(`#${i}: line missing a coordinate`); return;
        }
        if (x1 === x2 && y1 === y2) { dropped.push(`#${i}: line of zero length`); return; }
        shapes.push({ t: 'line', x1: cx(x1), y1: cy(y1), x2: cx(x2), y2: cy(y2), ...pen });
        return;
      }
      case 'rect': {
        const [x, y, w, h] = [num(s.x), num(s.y), num(s.w), num(s.h)];
        if (x === null || y === null || w === null || h === null) {
          dropped.push(`#${i}: rect missing a dimension`); return;
        }
        if (w <= 0 || h <= 0) { dropped.push(`#${i}: rect with no area`); return; }
        shapes.push({ t: 'rect', x: cx(x), y: cy(y), w: Math.min(w, width), h: Math.min(h, height), ...pen });
        return;
      }
      case 'circle': {
        const [c1, c2, r] = [num(s.cx), num(s.cy), num(s.r)];
        if (c1 === null || c2 === null || r === null || r <= 0) {
          dropped.push(`#${i}: circle without a centre and radius`); return;
        }
        shapes.push({ t: 'circle', cx: cx(c1), cy: cy(c2), r: Math.min(r, Math.min(width, height) / 2), ...pen });
        return;
      }
      case 'arc': {
        const [c1, c2, r, a0, a1] = [num(s.cx), num(s.cy), num(s.r), num(s.a0), num(s.a1)];
        if (c1 === null || c2 === null || r === null || r <= 0 || a0 === null || a1 === null) {
          dropped.push(`#${i}: arc missing centre, radius or angles`); return;
        }
        shapes.push({ t: 'arc', cx: cx(c1), cy: cy(c2), r, a0, a1, ...pen });
        return;
      }
      case 'poly': {
        if (!Array.isArray(s.pts)) { dropped.push(`#${i}: poly without points`); return; }
        const pts = s.pts
          .filter(p => Array.isArray(p) && num(p[0]) !== null && num(p[1]) !== null)
          .map(p => [cx(p[0]), cy(p[1])]);
        if (pts.length < 2) { dropped.push(`#${i}: poly with fewer than two usable points`); return; }
        shapes.push({ t: 'poly', pts, close: s.close === true, ...pen });
        return;
      }
      case 'text': {
        const [x, y] = [num(s.x), num(s.y)];
        const value = typeof s.s === 'string' ? s.s.trim() : '';
        if (x === null || y === null) { dropped.push(`#${i}: text without a position`); return; }
        if (!value) { dropped.push(`#${i}: empty text`); return; }
        const size = num(s.size);
        shapes.push({
          t: 'text', x: cx(x), y: cy(y), s: value.slice(0, 200),
          // A size the model invented can be a hundred units tall. Its own
          // suggestion is taken only when it is within reason of the sheet's.
          size: size && size > 0 && size < textSize * 4 ? size : textSize,
          ...pen,
        });
        return;
      }
      default:
        dropped.push(`#${i}: unknown shape "${String(s.t).slice(0, 20)}"`);
    }
  });

  return { shapes, dropped };
}

/**
 * Pull the drawing out of whatever the model actually said.
 *
 * "Answer with JSON only" is a request, not a guarantee. What comes back is
 * routinely JSON wrapped in prose, JSON in a ```fence, JSON after a block of
 * reasoning the server forgot to strip, or — most often on a long schematic —
 * JSON that simply stops mid-shape because the answer hit its token limit.
 *
 * Each of those is a different repair and they are tried in order of how
 * certain they are. Note what is *not* repaired: a shape. Closing a bracket
 * the model ran out of room for recovers shapes it did finish; inventing a
 * coordinate it never wrote would put a line in a schematic that nobody drew.
 * The first is reading, the second is making things up.
 */
function parseAnswer(text) {
  if (typeof text !== 'string') return null;
  const clean = stripReasoning(text);

  // 1. It did as it was asked.
  const direct = tryParse(clean) || tryParse(text);
  if (direct) return direct;

  // 2. It fenced it. Every fence, not just the first — a model that explains
  //    itself in one block and answers in the next is common.
  for (const m of clean.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    const parsed = tryParse(m[1]);
    if (parsed) return parsed;
  }

  // 3. It buried it. Scan from each opening brace or bracket to its match and
  //    take the first block that is actually a drawing — not merely the first
  //    that is valid JSON, which on a narrated answer is a small object the
  //    model wrote about itself.
  for (const found of balanced(clean)) {
    const parsed = tryParse(found);
    if (parsed && Array.isArray(parsed.shapes) && parsed.shapes.length > 0) return parsed;
  }

  // 4. It ran out of room. Close what is open and drop the half-written tail.
  const mended = mendTruncated(clean);
  if (mended) {
    const parsed = tryParse(mended);
    if (parsed) return parsed;
  }

  return null;
}

/** One candidate as the answer object, or null if it is not one. */
function tryParse(s) {
  try {
    const v = JSON.parse(String(s).trim());
    if (!v || typeof v !== 'object') return null;
    // A bare array is the wrapper dropped, which small models do often enough
    // to be worth taking. Nothing is skipped by accepting it — every element
    // still goes through validateShapes one field at a time.
    return Array.isArray(v) ? { shapes: v } : v;
  } catch { return null; }
}

/** Every balanced {...} or [...] block in the text, outermost first. */
function* balanced(text) {
  for (let i = 0; i < text.length; i++) {
    const open = text[i];
    if (open !== '{' && open !== '[') continue;
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (escaped) { escaped = false; continue; }
      if (c === '\\') { escaped = true; continue; }
      if (c === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (c === open) depth++;
      else if (c === close && --depth === 0) { yield text.slice(i, j + 1); i = j; break; }
    }
  }
}

/**
 * An answer that stopped mid-sentence, closed off.
 *
 * Walks the text tracking string state and bracket depth, cuts back to the
 * last point where a complete value had just been written, and closes
 * whatever is still open. A drawing that lost its final shape is still a
 * drawing; the alternative is losing all forty of them to the one that was
 * half-written when the model hit its limit.
 */
function mendTruncated(text) {
  const start = text.search(/[[{]/);
  if (start < 0) return null;
  const stack = [];
  let inString = false;
  let escaped = false;
  let safe = -1;
  // What was still open at that point — not what is open at the end. The
  // half-written shape the model stopped inside opened a brace of its own, and
  // closing that one would keep the very fragment being cut away.
  let safeStack = null;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (escaped) { escaped = false; continue; }
    if (c === '\\') { escaped = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']');
    else if (c === '}' || c === ']') {
      if (stack.pop() !== c) return null;      // not truncation, just broken
      safe = i;                                 // a value just finished here
      safeStack = [...stack];
    }
  }
  if (stack.length === 0 || safe < start || !safeStack || safeStack.length === 0) return null;
  // Cut back past any comma or key left dangling after the last whole value.
  return text.slice(start, safe + 1).replace(/,\s*$/, '') + safeStack.reverse().join('');
}

export function registerDrawAssistRoutes(app, callLocalModel) {
  app.post('/api/draw/generate', async (req, res) => {
    const { prompt, width, height, textSize } = req.body || {};
    if (typeof prompt !== 'string' || prompt.trim().length < 3) {
      return res.status(400).json({ success: false, error: 'Describe what to draw.' });
    }

    const bounds = {
      width: Number(width) > 0 ? Number(width) : 420,
      height: Number(height) > 0 ? Number(height) : 297,
      textSize: Number(textSize) > 0 ? Number(textSize) : 3,
    };

    try {
      const answer = await callLocalModel({
        system: systemPrompt(bounds),
        user: prompt.trim().slice(0, 2000),
        abortMs: Number(process.env.DRAW_ASSIST_TIMEOUT_MS) || 120000,
        // A schematic is a long answer. At the chat default it stops partway
        // through, and a drawing cut off mid-shape used to come back as
        // nothing at all — see `mendTruncated`, which now salvages what did
        // arrive, but the honest fix is to leave room for the whole thing.
        maxTokens: Number(process.env.DRAW_ASSIST_MAX_TOKENS) || 8192,
      });
      const text = typeof answer === 'string' ? answer : answer?.content ?? answer?.text ?? '';
      const parsed = parseAnswer(text);
      if (!parsed) {
        // What it *did* say goes back with the refusal. Without it the failure
        // is a dead end — the one question worth answering here is "what did
        // the model actually write", and only the model's own words answer it.
        return res.status(502).json({
          success: false,
          error: 'The model did not answer with drawable JSON.',
          raw: String(text).slice(0, 1200),
          model: answer?.model || '',
          transport: answer?.transport || '',
        });
      }

      const { shapes, dropped } = validateShapes(parsed.shapes, bounds);
      if (shapes.length === 0) {
        return res.status(422).json({
          success: false,
          error: 'Nothing in that answer could be drawn.',
          dropped: dropped.slice(0, 10),
          raw: String(text).slice(0, 1200),
          model: answer?.model || '',
          transport: answer?.transport || '',
        });
      }
      return res.json({
        success: true,
        shapes,
        note: typeof parsed.note === 'string' ? parsed.note.slice(0, 300) : '',
        dropped: dropped.slice(0, 10),
        droppedCount: dropped.length,
      });
    } catch (err) {
      const timedOut = err?.name === 'AbortError';
      return res.status(504).json({
        success: false,
        error: timedOut ? 'The model took too long to answer.' : `Could not reach the model: ${err.message}`,
      });
    }
  });
}

export { validateShapes, parseAnswer, systemPrompt, LAYERS, DASHES };
