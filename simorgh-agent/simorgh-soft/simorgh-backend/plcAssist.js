// Asking the model to write a PLC block.
//
// The ladder assistant next door writes a *program* from a sentence: a set of
// rungs, from nothing. This one works on a project that already exists —
// "add an interlock to Motor_Control", "write me an FB for a valve", "there
// are two errors in this block, fix them" — which is a different job and needs
// a different prompt.
//
// The difference is the **snapshot**. The browser writes down what is already
// there — the blocks, their interfaces, the tag table, the instruction
// vocabulary, and what the checker currently says is wrong — and sends it with
// the request. A model given that stops inventing tag names that nearly match
// the real ones, stops declaring a variable that is already declared, and
// stops calling blocks that do not exist. A model not given it does all three,
// every time, and the result looks plausible enough to waste an hour on.
//
// Nothing here writes anything into a project. The answer comes back as JSON,
// the browser reads it through `utils/plc/aiContext.ts` — which drops what it
// cannot make sense of and says so — and an engineer sees what would change
// before anything does. That order is the whole safety story: **a generated
// program is a draft for an engineer to read**, and the prompt says so in the
// answer it asks for.

import { parseAnswer } from './drawAssist.js';

/** How long a snapshot the browser may send. They run to a few kilobytes. */
const SNAPSHOT_LIMIT = 24000;
const VOCABULARY_LIMIT = 24000;

const clean = (v, limit) => String(v ?? '').trim().slice(0, limit);

function systemPrompt({ snapshot, vocabulary, language, style }) {
  return [
    'You write PLC blocks for a Siemens-style controller and explain them.',
    'Answer with JSON only, no prose outside it.',
    '',
    'THE PROGRAM AS IT IS NOW. Everything below already exists. Use these names',
    'exactly; do not invent a tag that nearly matches one of them, and do not',
    'declare a variable that is already declared.',
    '',
    snapshot,
    '',
    vocabulary ? 'THE INSTRUCTIONS THIS CONTROLLER HAS. Use these and nothing else:' : '',
    vocabulary || '',
    '',
    `THE ENGINEER IS WORKING IN: ${language || 'SCL'}`,
    '',
    'ANSWER WITH THIS SHAPE:',
    '{',
    '  "summary": "one sentence on what you wrote and why",',
    '  "blocks": [',
    '    {',
    '      "name": "Motor_Control",',
    '      "kind": "FB",',
    '      "language": "SCL",',
    '      "comment": "what the block is for",',
    '      "interface": [',
    '        {"section":"Input","name":"Start","dataType":"Bool","comment":"Start button"},',
    '        {"section":"Output","name":"Running","dataType":"Bool"},',
    '        {"section":"Static","name":"OffDelay","dataType":"TOF"}',
    '      ],',
    '      "code": "IF #Start AND #Stop THEN\\n    #Running := TRUE;\\nEND_IF;"',
    '    }',
    '  ],',
    '  "tags": [ {"name":"Start_PB","dataType":"Bool","address":"%I0.0","comment":"Start push button"} ],',
    '  "notes": ["anything the engineer must check before this is used"]',
    '}',
    '',
    'A BLOCK IN LAD OR FBD has "networks" instead of "code":',
    '  "networks": [',
    '    { "title": "Start and stop with seal-in",',
    '      "comment": "why it is built this way",',
    '      "rung": {',
    '        "groups": [',
    '          { "branches": [ {"elements":[{"k":"no","at":"\\"Start_PB\\"","label":"Start"}]},',
    '                          {"elements":[{"k":"no","at":"\\"Motor\\"","label":"Seal-in"}]} ] },',
    '          { "branches": [ {"elements":[{"k":"no","at":"\\"Stop_PB\\"","label":"Stop"}]} ] }',
    '        ],',
    '        "outputs": [ {"k":"coil","at":"\\"Motor\\"","label":"Motor contactor"} ]',
    '      } }',
    '  ]',
    '  "groups" are in SERIES: current must get through every one.',
    '  "branches" inside a group are in PARALLEL: any one passing is enough.',
    '  "elements" inside a branch are in SERIES with each other.',
    '  A contact\'s "k" is "no", "nc", "p" or "n"; an output\'s is "coil", "set",',
    '  "reset", "pulse-p" or "pulse-n". A box is {"k":"block","type":"TON",',
    '  "name":"#Timer","pins":[{"name":"IN","value":"..."},{"name":"PT","value":"T#5s"},',
    '  {"name":"Q","out":true}]}.',
    '',
    'HOW NAMES ARE WRITTEN:',
    '  #Local          a variable declared in this block\'s own interface',
    '  "Tag_Name"      a PLC tag, or another block',
    '  %I0.0 %QW64     an absolute address — only where there is no tag for it',
    '  T#5s  16#FF     a time literal, a hexadecimal number',
    '',
    'WHEN YOU DO NOT KNOW ENOUGH, ASK. DO NOT GUESS.',
    'Most of what makes a program right is not in the sentence you were given:',
    'whether the stop is maintained, what happens on a fault, how long a delay',
    'is, whether two motors may run together. Guessing any of those produces a',
    'block that looks finished and is wrong where nobody can see it. So when a',
    'choice would change the program, answer with QUESTIONS INSTEAD OF BLOCKS:',
    '{',
    '  "questions": [',
    '    { "ask": "What should happen when the overload trips?",',
    '      "why": "It decides whether the block needs a latch and a reset input.",',
    '      "options": [',
    '        {"label": "Stop, and need a reset before restarting", "note": "The usual choice on a motor"},',
    '        {"label": "Stop, and restart by itself when it cools"}',
    '      ],',
    '      "multi": false }',
    '  ]',
    '}',
    'At most four, all at once, each with two to four options written as what',
    'somebody would do rather than as jargon. Ask only what changes the program.',
    '',
    'RULES:',
    '  - Only change what was asked for. A block you were not asked about must not',
    '    appear in "blocks" at all — anything you list there replaces what is in',
    '    the project under that name.',
    '  - Every name you use is either declared in the interface you wrote, or is',
    '    in the tag list above, or is a block above, or is in "tags" as a new one.',
    '  - Prefer inputs and outputs over global tags inside an FB or an FC. A block',
    '    written against parameters can drive ten motors; the same logic written',
    '    against global tags can drive one.',
    '  - A stop button is wired normally closed, so a broken wire stops the',
    '    machine — which means it is read with a NORMALLY OPEN contact. Say so in',
    '    the notes when you use one.',
    '  - Temp variables are not initialised. Anything that must survive the call',
    '    is Static, and Static only exists in an FB or a DB.',
    '  - Guard a division whose divisor is a measured value.',
    '  - Keep it short. Ten lines that work beat forty that wander.',
    style === 'teach'
      ? '  - Write the comments for somebody who can read a circuit but has not used this software.'
      : '  - Write the comments for an engineer who knows this software.',
    '  - If what was asked is unsafe to do in software alone — an emergency stop,',
    '    a guard interlock with no hardware channel — say so in "notes" and write',
    '    what is safe instead.',
    '  - Put in "notes" anything an engineer must check before this is used. This',
    '    is a draft for them to read, not a program to download.',
  ].filter(Boolean).join('\n');
}

const looksLikeAnswer = v =>
  (Array.isArray(v?.blocks) && v.blocks.length > 0)
  || (Array.isArray(v?.questions) && v.questions.length > 0)
  || (Array.isArray(v?.tags) && v.tags.length > 0);

const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 6;

/** Questions, kept to what can be put on screen as buttons. */
function readQuestions(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw.slice(0, MAX_QUESTIONS)) {
    const ask = clean(item?.ask, 300);
    if (!ask) continue;
    const options = (Array.isArray(item?.options) ? item.options : [])
      .slice(0, MAX_OPTIONS)
      .map(o => ({
        label: clean(typeof o === 'string' ? o : o?.label, 140),
        note: clean(typeof o === 'string' ? '' : o?.note, 180),
      }))
      .filter(o => o.label);
    if (options.length < 2) continue;
    out.push({ ask, why: clean(item?.why, 300), options, multi: item?.multi === true });
  }
  return out;
}

export function registerPlcAssistRoutes(app, callLocalModel) {
  app.post('/api/plc/generate', async (req, res) => {
    const { task, snapshot, vocabulary, language, style, answers } = req.body || {};

    if (typeof task !== 'string' || task.trim().length < 3) {
      return res.status(400).json({ success: false, error: 'Describe what the block should do.' });
    }
    if (typeof snapshot !== 'string' || snapshot.trim().length < 20) {
      // Without the snapshot the model is writing against a project it cannot
      // see, and everything it names is a guess. That is the one failure this
      // route exists to prevent, so it is refused rather than attempted.
      return res.status(400).json({
        success: false,
        error: 'The program was not sent with the request, and a block written against a project '
          + 'the model cannot see names tags that do not exist.',
      });
    }

    try {
      const settled = (Array.isArray(answers) ? answers : [])
        .slice(0, 12)
        .map(a => `  ${clean(a?.ask, 300)} — ${clean(a?.chose, 300)}`)
        .filter(l => l.trim().length > 3);

      const user = settled.length
        ? `${task.trim().slice(0, 6000)}\n\nAlready settled, do not ask these again:\n${settled.join('\n')}`
        : task.trim().slice(0, 6000);

      const answer = await callLocalModel({
        system: systemPrompt({
          snapshot: clean(snapshot, SNAPSHOT_LIMIT),
          vocabulary: clean(vocabulary, VOCABULARY_LIMIT),
          language: clean(language, 20),
          style: style === 'teach' ? 'teach' : 'brief',
        }),
        user,
        abortMs: Number(process.env.PLC_ASSIST_TIMEOUT_MS) || 240000,
        maxTokens: Number(process.env.PLC_ASSIST_MAX_TOKENS) || 16384,
      });

      const text = typeof answer === 'string' ? answer : answer?.content ?? answer?.text ?? '';
      const parsed = parseAnswer(text, looksLikeAnswer);

      if (!parsed) {
        return res.status(502).json({
          success: false,
          error: 'The model did not answer with a block.',
          raw: String(text).slice(0, 2000),
          model: answer?.model || '',
        });
      }

      const questions = readQuestions(parsed.questions);
      if (questions.length > 0) {
        return res.json({ success: true, questions, model: answer?.model || '' });
      }

      // Handed on as it arrived. The browser reads it through the same reader a
      // saved project goes through, which is the one that already knows what a
      // legal block looks like — one validator rather than two that disagree.
      res.json({ success: true, generated: parsed, model: answer?.model || '' });
    } catch (err) {
      res.status(500).json({ success: false, error: err?.message || String(err) });
    }
  });
}

export { systemPrompt as plcSystemPrompt };
