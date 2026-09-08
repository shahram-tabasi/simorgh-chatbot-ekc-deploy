// The assistant's side of the chat endpoints: the system prompt that tells
// the model what it may do, the parser that pulls the tool calls back out of
// its answer, and the call to the model itself.
//
// Kept out of server.js so the prompt and the envelope parser can be
// exercised on their own — a change to either is a change to what the
// assistant will and will not do, and that deserves a test rather than a
// deploy.

// ── Tool-call protocol helpers ──────────────────────────────────────────────
// The frontend sends the user's prompt together with:
//   • `context`  — JSON snapshot of the active project (equipments, selected one, template counts)
//   • `tools`    — JSON schemas of the frontend tools the assistant is allowed to call
//   • `excelPreviews` — parsed rows from any attached Excel/CSV file
// The model must reply in this exact shape so the frontend can execute the calls:
//   {
//     "reply": "human-readable explanation in Persian if the user wrote Persian",
//     "tool_calls": [ { "name": "update_row", "args": {...} }, ... ]
//   }
// When the answer is purely conversational, `tool_calls` is `[]`.
export function buildSystemPrompt(toolSchemas, context, excelPreviews) {
  const toolsBlock = (Array.isArray(toolSchemas) && toolSchemas.length > 0)
    ? toolSchemas.map(t => {
        const args = Object.entries(t.args || {})
          .map(([k, v]) => `      "${k}": ${v.type}${v.required ? ' (required)' : ''} — ${v.description}`)
          .join('\n');
        return `  - ${t.name}: ${t.description}\n    args:\n${args}`;
      }).join('\n\n')
    : '  (no tools available)';

  const ctxText = context
    ? JSON.stringify(context, null, 2)
    : '(no project context)';

  const excelText = (Array.isArray(excelPreviews) && excelPreviews.length > 0)
    ? excelPreviews.map(p => {
        const headers = (p.rows && p.rows[0]) ? Object.keys(p.rows[0]) : [];
        const sample = (p.rows || []).slice(0, 3);
        return `[Excel: ${p.name}] columns=${JSON.stringify(headers)}, rowCount=${(p.rows || []).length}\n` +
               `  first rows: ${JSON.stringify(sample)}`;
      }).join('\n')
    : '(no spreadsheet attachments)';

  // The tab the user is looking at is the single most important piece of
  // context: it says what an unqualified instruction is about. Stated up
  // front, in words, rather than left for the model to find in the JSON.
  const tab = context && context.activeTab ? context.activeTab : null;
  const tabBlock = tab
    ? [
        '── THE SCREEN THE USER IS ON (read this first) ──',
        `The user is on the "${tab.label}" tab.`,
        tab.owns ? `That tab owns: ${tab.owns}` : '',
        'An instruction with no other subject is about THIS tab. Choose the tool from this tab\'s list.',
        'Never reach for another tab\'s tools unless the user names that tab, an equipment, a template or a row explicitly.',
        '',
      ].filter(Boolean).join('\n')
    : '── THE SCREEN THE USER IS ON ──\n(unknown — ask which tab they mean before editing anything)\n';

  return [
    'You are Simorgh AI, an electrical-design assistant embedded inside the Simorgh Soft application.',
    'You both ANSWER questions and ACT on the running project by calling tools.',
    'The user may write in Persian, English, or a mix; reply in the same language as the user.',
    '',
    tabBlock,
    'OUTPUT FORMAT (CRITICAL):',
    '  • Your entire response MUST be a SINGLE JSON object — nothing before it, nothing after it.',
    '  • No markdown fences (no ```json), no <think>/<analysis>/<commentary> tags, no narration of your reasoning.',
    '  • Start your response with `{` and end with `}`. Do NOT explain what you are about to do — just do it via tool_calls.',
    '  • Shape: {"reply": "<answer>", "tool_calls": [ {"name": "<tool>", "args": { ... }}, ... ]}',
    '  • The `reply` value IS rendered as Markdown in the UI — use **bold**, `code`, headings, bullet lists, and tables when they help.',
    '  • If you don\'t need to act, return tool_calls: [].',
    '  • If the user uploads a document and asks you to extract / fill in / use its data, your default behaviour is to ACT (via propose_changes), not to ask "what should I do?". Read the document, propose every field you can extract, and let the user uncheck what they don\'t want.',
    '',
    'Conversation history: the messages array contains earlier turns. Treat any text inside `<<<…>>>` blocks as document content (PDF/Excel) the user uploaded on a previous turn — it is still available to you, no need to ask for it again.',
    '',
    'You can drive every tab through tools:',
    '  • Project Definition  → set_project_fields, set_tech_setting, save_project',
    '  • Device Library      → add_library_device, update_library_device, delete_library_device',
    '  • Create Template     → create_template, search_templates, delete_template, find_similar_templates, set_template_property_parts',
    '  • Device Selection    → add_equipment, delete_equipment, select_equipment, add_row, update_row, bulk_update, delete_row, apply_excel, set_cell_color, set_row_color, list_equipments, list_rows',
    '  • Navigate            → set_active_tab (project | template | devices | output)',
    '  • Document extraction → propose_changes (STAGE changes for user approval — see rule below)',
    '',
    'IMPORTANT — document extraction workflow:',
    '  When the user uploads a PDF / image / Excel and asks you to "extract / fill in / read" data, you MUST NOT call set_project_fields, add_equipment, etc. directly.',
    '  Instead, call exactly ONE `propose_changes` tool whose `actions` array wraps the changes you would have made. The frontend shows the proposal as a preview card; the user clicks Apply to commit each one. This applies to every field you pull from the document — project metadata, technical settings, device library entries, equipment, rows, anything.',
    '',
    'TAB ROUTING (this is where most mistakes happen):',
    '  • Project Definition → project master data and TECHNICAL SETTINGS. "temperature / دما / دمای طراحی" is `set_tech_setting` with path "general.designTemperature". "altitude / ارتفاع" is "general.altitudeAboveSeaLevel". Wire sizes are "wireSize.*", wire colours "wireColor.*", painting "others.*".',
    '  • The device rows have NO temperature, altitude, wire-size or wire-colour column. If you find yourself calling `update_row` or `bulk_update` with one of those, you have picked the wrong tab\'s tool — use `set_tech_setting` instead.',
    '  • `update_row` / `bulk_update` / `set_row_color` / `set_cell_color` / `add_row` / `delete_row` are ONLY for the columns listed below, and only when the user is on Device Selection or names a row or an equipment.',
    '  • Device Library (panel specifications: IP, RAL, busbar sizes, dimensions, insulation and service voltage) lives on Project Definition → `update_library_device`, not on the rows.',
    '',
    'Rules:',
    '  • Only call tools listed in "Available tools" below — do not invent names.',
    '  • Prefer one `bulk_update` over many `update_row` calls when the predicate covers it.',
    '  • Column field names you may reference: wiringType, ratingPower, flc, feederNo, busSection, tag, description, cableSize, sfdHfd, moduleNo, size, templateName.',
    '  • Equipment/library devices/templates are identified by `name` (case-insensitive). If the user doesn\'t name one, default to the active equipment from context.',
    '  • If a row number is out of range or a referenced thing doesn\'t exist, return tool_calls: [] and explain it in `reply`.',
    '  • When applying an attached Excel, use `apply_excel` — `columnMapping` keys MUST match the spreadsheet header names exactly as shown.',
    '  • You may emit multiple tool calls in one reply (e.g. set_active_tab → then create_template). Calls run in array order.',
    '',
    'Examples — STUDY THESE.',
    'Example 1 (user: "row 3 feederNo to L03"):',
    '  {"reply":"Set row **#3** `feederNo` to `L03`.","tool_calls":[{"name":"update_row","args":{"rowNumber":3,"column":"feederNo","value":"L03"}}]}',
    'Example 2 (user: "هرجا wiringType مساوی M3 است را M4 کن"):',
    '  {"reply":"تمام ردیف‌هایی که `wiringType=M3` دارند به `M4` تغییر یافت.","tool_calls":[{"name":"bulk_update","args":{"where":{"column":"wiringType","equals":"M3"},"set":{"column":"wiringType","value":"M4"}}}]}',
    'Example 3 (user: "what equipment do I have?"):',
    '  {"reply":"## Equipment\\n\\n| Name | Type | Rows |\\n|---|---|---|\\n| test | LV | 4 |\\n| testmv | MV | 3 |\\n","tool_calls":[]}',
    'Example 4 (user: "open the template tab"):',
    '  {"reply":"Switched to **Create Template**.","tool_calls":[{"name":"set_active_tab","args":{"tab":"template"}}]}',
    'Example 5 (user: "create a new project named Pars Refinery, standard IEC, client NIORDC"):',
    '  {"reply":"Updated project metadata.","tool_calls":[{"name":"set_project_fields","args":{"fields":{"projectName":"Pars Refinery","standard":"IEC","client":"NIORDC"}}}]}',
    'Example 6 (user: "add a new LV equipment called MCC-01 then go to device selection"):',
    '  {"reply":"Added **MCC-01** and switched to the Device Selection tab.","tool_calls":[{"name":"add_equipment","args":{"name":"MCC-01","type":"LV"}},{"name":"set_active_tab","args":{"tab":"devices"}}]}',
    'Example 7 (user: "list LV templates that contain S8"):',
    '  {"reply":"Found 2 matching LV templates:\\n\\n- **Motor 22kW** — S8/OFW/FCB1/OUTGOING · motor · 22 kW\\n- **Motor 30kW** — S8/OFW/FCB1/OUTGOING · motor · 30 kW","tool_calls":[{"name":"search_templates","args":{"query":"S8","type":"LV"}}]}',
    'Example 8a (user is on **Project Definition** and writes "دمای 50 درجه شود"):',
    '  {"reply":"دمای طراحی روی **50 °C** تنظیم شد.","tool_calls":[{"name":"set_tech_setting","args":{"path":"general.designTemperature","value":"50"}}]}',
    '  WRONG for that prompt: {"name":"bulk_update","args":{"where":{"column":"designTemperature",...}}} — there is no such column, and the user was not looking at the rows.',
    'Example 8b (user is on **Project Definition** and writes "ارتفاع 1200 باشد"):',
    '  {"reply":"ارتفاع از سطح دریا **1200 m** شد.","tool_calls":[{"name":"set_tech_setting","args":{"path":"general.altitudeAboveSeaLevel","value":"1200"}}]}',
    'Example 8c (user is on **Device Selection** and writes "دمای ردیف 3 را 50 کن"): the row columns hold no temperature —',
    '  {"reply":"ردیف‌ها ستون دما ندارند. دمای طراحی در تب Project Definition تنظیم می‌شود — همان را عوض کنم؟","tool_calls":[]}',
    'Example 8 (user: "row 100" but only 4 rows exist):',
    '  {"reply":"Row 100 doesn\'t exist — the active equipment has only 4 rows. Want me to add one?","tool_calls":[]}',
    'Example 9 (user uploads project_report.pdf and asks "fill in the project from this"):',
    '  {"reply":"I read **project_report.pdf** and found the following — review and click Apply.","tool_calls":[{"name":"propose_changes","args":{"title":"Extracted from project_report.pdf","actions":[{"name":"set_project_fields","args":{"fields":{"projectName":"Pars Refinery Phase II","client":"NIORDC","standard":"IEC","location":"Bandar Abbas","planner":"SIMORGH"}},"summary":"Set project metadata (5 fields)"},{"name":"set_tech_setting","args":{"path":"general.altitudeAboveSeaLevel","value":"15"},"summary":"Altitude = 15 m"},{"name":"set_tech_setting","args":{"path":"general.designTemperature","value":"50"},"summary":"Design temperature = 50 °C"},{"name":"add_equipment","args":{"name":"MCC-01","type":"LV"},"summary":"Add LV equipment MCC-01"},{"name":"add_equipment","args":{"name":"SWB-MV","type":"MV"},"summary":"Add MV equipment SWB-MV"}]}}]}',
    '',
    '── Project context (THE source of truth — read it before answering) ──',
    ctxText,
    '',
    '── Spreadsheet attachments ──',
    excelText,
    '',
    '── Available tools ──',
    toolsBlock,
    '',
    'REVIEW: an engineer approves every change before it reaches the project — the app shows your tool calls as a checklist with an Apply button. So propose the complete change you believe is right and say plainly what it does; do not ask for permission in `reply`, and do not water a change down because you are unsure it will be accepted. Being explicit about what each call changes is what makes the review possible.',
    '',
    'Now produce the single JSON object response.',
  ].join('\n');
}

// Strip reasoning / analysis chatter that reasoning-class models prepend to
// the actual answer. Covers three families:
//
//   1) <think>…</think> + variants (DeepSeek / Claude / generic).
//   2) Harmony-format channels used by gpt-oss-20b. The raw output looks
//      like  `<|channel|>analysis<|message|>…<|end|>`
//             `<|start|>assistant<|channel|>final<|message|>…<|end|>`
//      and we want only the final-channel content (or whatever sits after
//      the last channel marker if no final channel is present).
//   3) The leading "analysis…assistantfinal …" form that ai_service on .61
//      occasionally emits when the channel markers are flattened to text.
export function stripReasoning(content) {
  if (typeof content !== 'string') return '';
  let out = content;

  // ── 1) Standard reasoning tags ──────────────────────────────────────────
  const patterns = [
    /<think>[\s\S]*?<\/think>/gi,
    /<thinking>[\s\S]*?<\/thinking>/gi,
    /<reasoning>[\s\S]*?<\/reasoning>/gi,
    /<reason>[\s\S]*?<\/reason>/gi,
    /<analysis>[\s\S]*?<\/analysis>/gi,
    /<analyze>[\s\S]*?<\/analyze>/gi,
    /<plan>[\s\S]*?<\/plan>/gi,
    /<planning>[\s\S]*?<\/planning>/gi,
    /<scratchpad>[\s\S]*?<\/scratchpad>/gi,
    /<scratch>[\s\S]*?<\/scratch>/gi,
    /<cot>[\s\S]*?<\/cot>/gi,
    /<chain_of_thought>[\s\S]*?<\/chain_of_thought>/gi,
    /<step>[\s\S]*?<\/step>/gi,
    /<steps>[\s\S]*?<\/steps>/gi,
    /<internal>[\s\S]*?<\/internal>/gi,
    /<commentary>[\s\S]*?<\/commentary>/gi,
  ];
  for (const p of patterns) out = out.replace(p, '');
  out = out.replace(/<think>[\s\S]*$/i, '');

  // ── 2) Harmony channels (gpt-oss). Prefer the LAST `final`-channel block. ─
  // Match BOTH the proper bracketed form and the flattened text form.
  const harmonyFinal = out.match(/<\|channel\|>\s*final\s*<\|message\|>([\s\S]*?)(?:<\|(?:end|return|start)\|>|$)/i);
  if (harmonyFinal) {
    out = harmonyFinal[1];
  } else {
    // Sometimes the server strips the angle brackets, leaving plain
    // "analysis<reasoning>…assistantfinal<answer>" or "…analysis…final…"
    // We keep only the substring after the last "final" marker.
    const flatFinal = out.match(/(?:^|\s)final\b[\s:]*([\s\S]*)$/i);
    const flatAssistantFinal = out.match(/assistant\s*final[\s:]*([\s\S]*)$/i);
    if (flatAssistantFinal) out = flatAssistantFinal[1];
    else if (flatFinal && /\banalysis\b|\bcommentary\b/i.test(content)) out = flatFinal[1];
  }

  // ── 3) Strip any leftover harmony tokens — `<|whatever|>` and the
  //       Cyrillic/Greek lookalikes some tokenizers emit. ──────────────────
  out = out.replace(/<\|[^|>]*\|>/g, '');
  out = out.replace(/<\/?(?:start|end|message|channel|return)>/gi, '');

  return out.trim();
}

// Pull a JSON envelope out of the model's reply. The model is instructed to
// emit raw JSON; in practice it sometimes wraps it in prose, fences, or
// preceding <think> blocks (gpt-oss-20b). Strip reasoning first, then try
// progressively looser parses.
export function extractToolEnvelope(content) {
  if (typeof content !== 'string') content = String(content ?? '');
  content = stripReasoning(content);
  const tryParse = (s) => {
    try {
      const obj = JSON.parse(s);
      if (obj && typeof obj === 'object') {
        return {
          reply: typeof obj.reply === 'string' ? obj.reply : '',
          tool_calls: Array.isArray(obj.tool_calls) ? obj.tool_calls : [],
        };
      }
    } catch { /* not JSON */ }
    return null;
  };

  // 1) Whole content as JSON
  const whole = tryParse(content.trim());
  if (whole) return whole;

  // 2) Fenced ```json … ```
  const fence = content.match(/```(?:json)?\s*([\s\S]+?)```/i);
  if (fence) {
    const parsed = tryParse(fence[1].trim());
    if (parsed) return parsed;
  }

  // 3) First balanced `{...}` block via brace counting
  const start = content.indexOf('{');
  if (start >= 0) {
    let depth = 0;
    for (let i = start; i < content.length; i++) {
      if (content[i] === '{') depth++;
      else if (content[i] === '}') {
        depth--;
        if (depth === 0) {
          const parsed = tryParse(content.slice(start, i + 1));
          if (parsed) return parsed;
          break;
        }
      }
    }
  }

  // 4) Pure text reply, no tools
  return { reply: content, tool_calls: [] };
}

// Where the assistant thinks. The VLM on 192.168.1.61, unless .env says
// otherwise — LOCAL_MODEL_URL / LOCAL_MODEL_NAME are passed through by
// compose so the address is an edit and a restart, never a rebuild.
export const DEFAULT_LOCAL_MODEL_URL =
  process.env.LOCAL_MODEL_URL || 'http://192.168.1.61/v1/chat/completions';
export const DEFAULT_LOCAL_MODEL_NAME =
  process.env.LOCAL_MODEL_NAME || 'qwen2.5-vl-7b';

// Call the local LLM. Three transports are supported (see paths A/B/C below).
// `history` is the prior turns (alternating user/assistant) without the
// system message — we prepend system here and append the new user turn.
export async function callLocalModel({ system, user, history, model, abortMs }) {
  const gatewayUrl = process.env.LLM_GATEWAY_URL;
  const aiSvcBase  = process.env.AI_SERVICE_URL;            // bespoke /generate service
  // The assistant runs on the VLM (Qwen2.5-VL) served OpenAI-compatibly on
  // 192.168.1.61. It is instruction-tuned and honours
  // `response_format: json_object`, which is what the tool-call contract
  // needs — a reasoning model narrates instead of answering in JSON, and
  // the app then has nothing to execute.
  //
  // Both parts are env-driven (LOCAL_MODEL_URL / LOCAL_MODEL_NAME, passed
  // through by compose), so moving the model to another host or another
  // port is an edit to .env and a restart, not a rebuild.
  const explicit   = process.env.LOCAL_MODEL_URL
                  || (aiSvcBase ? null : DEFAULT_LOCAL_MODEL_URL);
  const apiKey     = process.env.LOCAL_MODEL_KEY || process.env.LOCAL_LLM_API_KEY || '';

  // Build the full message thread (system + history + user).
  const cleanHistory = (Array.isArray(history) ? history : [])
    .filter(m => m && typeof m.content === 'string' && (m.role === 'user' || m.role === 'assistant'))
    .map(m => ({ role: m.role, content: m.content }));

  const messages = [
    { role: 'system', content: system },
    ...cleanHistory,
    { role: 'user', content: user },
  ];
  const headers = {
    'Content-Type': 'application/json',
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), abortMs || 300_000);

  try {
    // ── Path A: llm-gateway ─────────────────────────────────────────────
    if (gatewayUrl) {
      const url = gatewayUrl.replace(/\/+$/, '') + '/generate';
      const body = {
        messages,
        mode: process.env.LLM_GATEWAY_MODE || 'offline',  // → local LLM cluster
        temperature: 0.1,
      };
      const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
      const text = await res.text();
      if (!res.ok) throw new Error(`llm-gateway ${res.status}: ${text.slice(0, 500)}`);
      let json; try { json = JSON.parse(text); } catch { json = {}; }
      return { content: json.response ?? '', raw: json, url, transport: 'llm-gateway', model: json.model || DEFAULT_LOCAL_MODEL_NAME };
    }

    // ── Path B: ai-service /generate (only if AI_SERVICE_URL is set) ────
    // .61's /v1/chat/completions auto-routes to a LangChain Wikipedia/
    // search agent whenever the project context contains keywords like
    // "iec" / "current" / "siemens". /generate with use_tools=false bypasses
    // that routing, but gpt-oss-20b is a reasoning model that mostly
    // refuses to emit our JSON envelope, so this path is opt-in only.
    if (aiSvcBase) {
      const base = aiSvcBase.replace(/\/+$/, '');
      const url  = `${base}/generate`;
      const historyText = cleanHistory.length === 0 ? '' :
        '── Conversation history ──\n' +
        cleanHistory.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n') +
        '\n\n── Current user turn ──\n';
      const userPrompt = historyText + 'USER: ' + user;
      const body = {
        system_prompt: system,
        user_prompt:   userPrompt,
        thinking_level: process.env.LOCAL_MODEL_REASONING || 'low',
        max_tokens:    Number(process.env.LOCAL_MODEL_MAX_TOKENS || 4096),
        stream: false,
        use_tools: false,
      };
      const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
      const text = await res.text();
      if (!res.ok) throw new Error(`ai-service ${res.status}: ${text.slice(0, 500)}`);
      let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
      const content = json?.output ?? json?.response ?? json?.raw ?? '';
      return { content, raw: json, url, transport: 'ai-service', model: json?.model || DEFAULT_LOCAL_MODEL_NAME };
    }

    // ── Path C: OpenAI-compatible chat URL (DEFAULT — the VLM on .61) ───
    // The server runs upstream `vllm/vllm-openai`, so it honours
    // response_format for guided JSON decoding. That plus the VLM's
    // instruction-following is what makes the tool calls reliable.
    const url = explicit;
    const body = {
      model: model || DEFAULT_LOCAL_MODEL_NAME,
      messages,
      temperature: 0.1,
      max_tokens: Number(process.env.LOCAL_MODEL_MAX_TOKENS || 4096),
      response_format: { type: 'json_object' },
    };
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`Local model ${res.status}: ${text.slice(0, 500)}`);
    let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
    const content =
      json?.choices?.[0]?.message?.content ??
      json?.response ??
      json?.raw ??
      '';
    return { content, raw: json, url, transport: 'openai-compatible', model: body.model };
  } finally {
    clearTimeout(timer);
  }
}
