// partsMatch.js — which parts a kind of device, or MV / LV, takes in.
//
// The parts table has no kind and no voltage of its own, so both are read
// from a part's type number and descriptions, the same way for SQL Server
// (LIKE patterns) and for the Access file (in memory):
//
//   * a type-number family (3VA, 3AH, 7SJ…) or a short word (ACB, SPD) is
//     matched at the start of a word only — "3AH" is not the "23Ah" of a
//     battery, "SION" is not the end of "version";
//   * a longer word is matched anywhere, so German compounds still count
//     ("Kompaktleistungsschalter").
//
// MV is what says so: the word "MV", the Siemens MV families (3AE, 3AH, 3TL, 4MR…), "medium
// voltage", or a rating above 1 kV (12 kV, 3.6kV, 17.5 kV — never kVA, and
// never 0.4 kV or 0,6/1 kV). LV is everything that is not MV.
//
// A switching device (a breaker, a contactor) under MV has to say it is MV;
// a relay, a meter or a selector — which say neither — is kept under MV too
// unless it names an LV family.

const MV_FAMILIES = [
  '3ae', '3ah', '3af', '3ak', '3tl', '3tm', '3ad', '3cg', '3gd',
  '4mr', '4mt', '4ma', '4mc', '4mb', '4ms', '4me',
  'simoprime', 'nxair', 'nxplus', '8da', '8dj', '8dh', 'sion',
  'medium voltage', 'medium-voltage', 'mittelspannung',
];
const LV_FAMILIES = [
  '3va', '3wa', '3wl', '3vl', '3vm', '3vt', '3rv', '3rt', '3ru', '3rb', '3ua', '3nj', '3kd', '3kl',
  '5sy', '5sl', '5sv', '5sj', '5sp', 'mccb', 'mcb', 'acb', 'low voltage', 'niederspannung',
];

/** Matched at the start of a word: a family code, or a short word. */
const atWordStart = w => /\d/.test(w) || w.length <= 4;

// "MV" and "LV" as words of their own, as EPLAN's parts say it — "MV Current
// Transformer", "Corebalance CT (MV)" — never the start of "MVA" or "MVAr".
const MV_WHOLE = ['mv'];
const LV_WHOLE = ['lv'];
const hasWhole = (t, w) => new RegExp(`[^0-9a-z]${w}[^0-9a-z]`).test(t);
const likeWhole = w => `%[^0-9a-z]${w}[^0-9a-z]%`;

/** The text a part is matched in: type number and descriptions, lower case,
 *  with a space at each end so a word at the edge has a neighbour too. */
export const matchText = r => ` ${['typenr', 'description1', 'description2', 'description3']
  .map(f => (r[f] == null ? '' : String(r[f]))).join(' ').toLowerCase()} `;

const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Does the part's text hold the word, as the rule above says? */
export function hasWord(t, w) {
  const word = String(w).trim().toLowerCase();
  if (!word) return false;
  return atWordStart(word) ? new RegExp(`[^0-9a-z]${escRe(word)}`).test(t) : t.includes(word);
}

/** A rating above 1 kV anywhere in the text. */
export function hasMvRating(t) {
  for (const m of t.matchAll(/(^|[^0-9.,])(\d+(?:[.,]\d+)?)\s?kv(?![a-z])/g)) {
    if (Number(m[2].replace(',', '.')) > 1) return true;
  }
  return false;
}

export const isMv = t => hasMvRating(t) || MV_WHOLE.some(w => hasWhole(t, w)) || MV_FAMILIES.some(w => hasWord(t, w));
export const isLvFamily = t => LV_WHOLE.some(w => hasWhole(t, w)) || LV_FAMILIES.some(w => hasWord(t, w));

/** Is the part in this voltage? `strict`: a switching device, which must say MV. */
export function voltageOk(t, voltage, strict) {
  if (voltage === 'LV') return !isMv(t);
  if (voltage === 'MV') return isMv(t) || (!strict && !isLvFamily(t));
  return true;
}

// ── The same, as SQL Server LIKE patterns on one text column `t` ──────────
// (the default collation is case-insensitive, so [a-z] takes A–Z as well).

const likeEsc = s => s.replace(/[[\]%_]/g, c => `[${c}]`);

/** The LIKE pattern for a word. */
export const likeOf = w => {
  const word = String(w).trim().toLowerCase();
  return atWordStart(word) ? `%[^0-9a-z]${likeEsc(word)}%` : `%${likeEsc(word)}%`;
};

// Above 1 kV: 2–9, 10–999, 1.2–9.9 and 10.5–99.9, with or without a space —
// and the character before the number is not a digit or a decimal mark, so
// 0,69 kV and 0.4kV stay out. The text ends in a space, so "kV" at the end
// is followed by something.
const KV_LIKE = ['[2-9]', '[1-9][0-9]', '[1-9][0-9][0-9]', '[1-9][.,][0-9]', '[1-9][0-9][.,][0-9]']
  .flatMap(n => [`%[^0-9.,]${n}kv[^a-z]%`, `%[^0-9.,]${n} kv[^a-z]%`]);

/**
 * The WHERE part for a kind and a voltage, against the text column `t`, with
 * its parameters added to `params`. Empty when there is nothing to narrow.
 */
export function sqlFilter({ kindWords = [], voltage = '', strict = false }, params) {
  const where = [];
  let n = 0;
  const anyOf = patterns => `(${patterns.map(p => {
    const key = `m${n++}`;
    params[key] = p;
    return `t LIKE @${key}`;
  }).join(' OR ')})`;
  const kinds = kindWords.map(w => String(w ?? '').trim()).filter(Boolean);
  if (kinds.length) where.push(anyOf(kinds.map(likeOf)));
  if (voltage === 'MV' || voltage === 'LV') {
    const mv = anyOf([...KV_LIKE, ...MV_WHOLE.map(likeWhole), ...MV_FAMILIES.map(likeOf)]);
    if (voltage === 'LV') where.push(`NOT ${mv}`);
    else if (strict) where.push(mv);
    else where.push(`(${mv} OR NOT ${anyOf([...LV_WHOLE.map(likeWhole), ...LV_FAMILIES.map(likeOf)])})`);
  }
  return where;
}

/** The text column for the SQL query, built once per row. */
export const SQL_TEXT = `CROSS APPLY (SELECT LOWER(' ' + ISNULL(CAST(typenr AS nvarchar(max)), '')
  + ' ' + ISNULL(CAST(description1 AS nvarchar(max)), '')
  + ' ' + ISNULL(CAST(description2 AS nvarchar(max)), '')
  + ' ' + ISNULL(CAST(description3 AS nvarchar(max)), '') + ' ') AS t) AS pm`;
