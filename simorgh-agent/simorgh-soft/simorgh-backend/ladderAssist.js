// Asking the local model to write ladder.
//
// The same split as the drawing assistant: the model is good at "start, stop,
// seal-in, overload, contactor" and bad at remembering that a Mitsubishi timer
// is not a TON. So it is handed the vendor's own vocabulary — written out in
// the browser from `utils/ladder/dialects.ts`, because that is where the table
// lives — and told that nothing outside it exists.
//
// What comes back is JSON describing rungs. Nothing here draws anything: the
// browser validates it element by element with `readProgram` and draws it from
// its own renderer. This file's job is to ask well, to salvage an answer that
// was fenced or truncated, and to refuse anything that is not a program.
//
// Two things this deliberately does not claim. It does not produce a file any
// vendor's software will import — it produces a drawing and an explanation,
// which is what was asked for. And it does not check that the logic is right:
// a language model writing a safety interlock is a draft for an engineer to
// read, and the prompt says so in the answer it asks for.

import { parseAnswer } from './drawAssist.js';

/** How long a briefing the browser may send. Generous; they are ~1–2 kB. */
const BRIEFING_LIMIT = 8000;

const clean = (v, limit) => String(v ?? '').trim().slice(0, limit);

/**
 * What the model is told.
 *
 * The shape of the answer is given as a worked example rather than a schema,
 * because every small model does better with one, and the example is a real
 * rung — start/stop with a seal-in — so that copying its shape produces
 * something correct rather than something merely well-formed.
 */
function systemPrompt({ briefing, controller, language, style }) {
  return [
    'You write PLC ladder programs and explain them. Answer with JSON only, no prose outside it.',
    '',
    'THE CONTROLLER THIS IS FOR:',
    controller ? `  ${controller}` : '  (not stated — say so in your first step)',
    language ? `  The engineer works in: ${language}` : '',
    '',
    'THE VENDOR\'S OWN VOCABULARY. Use these and nothing else:',
    briefing,
    '',
    'ANSWER WITH THIS SHAPE:',
    '{',
    '  "title": "what the program does, in a few words",',
    '  "steps": [',
    '    { "title": "Rung 1 — start and stop", "explain": "why it is built this way, in plain words", "rungs": [1] }',
    '  ],',
    '  "rungs": [',
    '    {',
    '      "comment": "the rung comment, as it would be typed into the software",',
    '      "groups": [',
    '        { "branches": [ { "elements": [ {"k":"no","at":"%I0.0","label":"Start"} ] },',
    '                        { "elements": [ {"k":"no","at":"%Q0.0","label":"Seal-in"} ] } ] },',
    '        { "branches": [ { "elements": [ {"k":"nc","at":"%I0.1","label":"Stop"} ] } ] }',
    '      ],',
    '      "outputs": [ {"k":"coil","at":"%Q0.0","label":"Motor contactor"} ]',
    '    }',
    '  ],',
    '  "tags": [ {"at":"%I0.0","name":"Start_PB","type":"Bool","kind":"input","comment":"Start push button"} ]',
    '}',
    '',
    'HOW A RUNG IS BUILT:',
    '  "groups" are read left to right and are in SERIES: current must get through every one.',
    '  "branches" inside a group are in PARALLEL: current gets through if any one of them passes.',
    '  "elements" inside a branch are in SERIES with each other.',
    '  So a start button in parallel with a seal-in contact is one group with two branches;',
    '  a stop button after it is the next group with one branch.',
    '',
    'CONTACTS: "k" is "no" (normally open), "nc" (normally closed),',
    '  "p" (rising edge) or "n" (falling edge). "at" is the address or tag.',
    'OUTPUTS: "k" is "coil", "set", "reset", "pulse-p" or "pulse-n".',
    'BLOCKS: {"k":"block","type":"TON","name":"instance","pins":[',
    '  {"name":"IN","value":"%M0.0"},{"name":"PT","value":"T#5s"},',
    '  {"name":"Q","out":true},{"name":"ET","value":"%MD10","out":true}]}',
    '  Use only the block types and pin names listed above for this vendor.',
    '  Pin names are the vendor\'s, spelled exactly as listed. A pin with nothing on',
    '  it keeps its name and leaves "value" out.',
    '',
    'RULES:',
    '  - Every rung drives something. A rung with conditions and no output is not a rung.',
    '  - A stop button is a normally closed contact wired to a normally open input, so a',
    '    broken wire stops the machine. Say so in the step that introduces it.',
    '  - Every address you use appears in "tags", with what it is.',
    '  - Addresses follow this vendor\'s scheme exactly. Do not write %I0.0 for a',
    '    Mitsubishi controller or X0 for a Siemens one.',
    '  - "steps" walks through the program in the order somebody would build it, and',
    '    every rung belongs to exactly one step.',
    '  - Keep it to the rungs the task needs. Ten rungs that work beat thirty that wander.',
    style === 'teach'
      ? '  - Explain as though to somebody who can read a circuit but has not used this software.'
      : '  - Explain briefly; the reader is an engineer who knows this software.',
    '  - If the task is unsafe to automate this way — an emergency stop through software',
    '    alone, a guard interlock with no hardware channel — say so in the first step and',
    '    write what is safe instead.',
  ].filter(Boolean).join('\n');
}

/** Is this parsed object actually a program? */
const looksLikeProgram = v => Array.isArray(v?.rungs) && v.rungs.length > 0;

export function registerLadderAssistRoutes(app, callLocalModel) {
  app.post('/api/ladder/generate', async (req, res) => {
    const { task, briefing, controller, language, style } = req.body || {};

    if (typeof task !== 'string' || task.trim().length < 3) {
      return res.status(400).json({ success: false, error: 'Describe what the program should do.' });
    }
    if (typeof briefing !== 'string' || briefing.trim().length < 20) {
      // The briefing is the whole guard against a Siemens block on a Mitsubishi
      // controller. Writing a program without it would produce something that
      // looks right and cannot be typed in, which is the failure this feature
      // exists to avoid — so it is refused rather than guessed at.
      return res.status(400).json({
        success: false,
        error: 'No vendor vocabulary was sent, and a program written without one cannot be trusted to the right dialect.',
      });
    }

    try {
      const answer = await callLocalModel({
        system: systemPrompt({
          briefing: clean(briefing, BRIEFING_LIMIT),
          controller: clean(controller, 120),
          language: clean(language, 60),
          style: style === 'teach' ? 'teach' : 'brief',
        }),
        user: task.trim().slice(0, 4000),
        abortMs: Number(process.env.LADDER_ASSIST_TIMEOUT_MS) || 180000,
        // A program with its explanation is a long answer — longer than a
        // drawing, because every rung carries a comment and a step.
        maxTokens: Number(process.env.LADDER_ASSIST_MAX_TOKENS) || 12288,
      });

      const text = typeof answer === 'string' ? answer : answer?.content ?? answer?.text ?? '';
      const parsed = parseAnswer(text, looksLikeProgram);

      if (!parsed) {
        // What it did say goes back with the refusal: the one question worth
        // answering here is what the model actually wrote.
        return res.status(502).json({
          success: false,
          error: 'The model did not answer with a ladder program.',
          raw: String(text).slice(0, 1500),
          model: answer?.model || '',
        });
      }

      // Handed on as it arrived. The browser validates it element by element —
      // that code already exists there, it is what a saved program is read back
      // through, and one validator is better than two that disagree.
      res.json({
        success: true,
        program: parsed,
        model: answer?.model || '',
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err?.message || String(err) });
    }
  });
}

export { systemPrompt as ladderSystemPrompt };
