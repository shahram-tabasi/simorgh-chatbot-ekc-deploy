# Template Hierarchy, Storage & AI Chatbot Architecture

This note covers three closely-related design questions:

1. **Storage** — should the template catalog live in MongoDB or PostgreSQL?
2. **Hierarchy** — how templates are classified and how the recommender
   short-lists existing ones for the user.
3. **Chatbot AI** — how the in-app chatbot is able to both answer
   questions *and* perform actions on the project at the same time.

The companion code lives in:

- `src/types/project.ts` — `TemplateHierarchy`, `TemplateLeafKind` types.
- `src/services/chatbotTools.ts` — the tool registry the chatbot uses.
- `src/components/Chatbot/Chatbot.tsx` — wiring of tool calls.

---

## 1. Storage: stay on MongoDB

The team is already on MongoDB. There is no reason to migrate to
PostgreSQL for this use-case:

| Need                                  | MongoDB | Postgres |
|---------------------------------------|---------|----------|
| Deeply nested template documents      | native  | JSONB    |
| Hierarchical path queries             | easy    | easy     |
| Embedded `parts[]` per property       | natural | JSONB    |
| Project document size (< 16 MB)       | fits    | fits     |
| AI similarity lookup by `(path, kW, A)` | index  | index   |

The recommender below is a simple equality / range lookup, not a
graph-traversal or full-text join, so neither engine has an advantage.
Keeping MongoDB avoids a migration that buys us nothing.

## 2. Template hierarchy

### LV path

```
              ┌── CCS
              ├── OFF
S8  / 8PT ─── ├── OFW ─── SFD / HFD / FCB1 / FCB2 / FCB3 ─── INCOMING /
              │                                              COUPLING /
              │                                              METERING /
              │                                              RISER /
              │                                              MET&RISER /
              │                                              OUTGOING
              ├── MARSHALING
              └── SWING
```

Leaf kinds:

- **FCB → OUTGOING** → `motor` or `transformer`, classified by **kW** +
  **current** + the parts that make it up.
- **SFD / HFD** → `motor` or `lighting`, classified by **kW** +
  **current** + parts.

### MV path

Only one tier deep:

```
INCOMING / COUPLING / METERING / RISER / MET&RISER / OUTGOING
```

Each can be a `motor` or `transformer`, classified by **kW** +
**current** + parts.

### MongoDB shape

A template document looks like:

```jsonc
{
  "_id": "tmpl-abc",
  "projectId": "proj-123",
  "name": "Motor 22kW Type A",
  "type": "LV",
  "hierarchy": {
    "path": ["S8", "OFW", "FCB1", "OUTGOING"],
    "leafKind": "motor",
    "params": { "kw": "22", "currentA": "44" }
  },
  "properties": {
    "CB ORDER":    { "parts": [{ "partNumber": "3VA1...", "label": "Q1", "quantity": 1 }] },
    "CT RATING":   { "parts": [...] },
    "__displayNames": { ... },
    "__locked": []
  }
}
```

Useful indexes on the `templates` collection:

```js
db.templates.createIndex({ projectId: 1, type: 1, "hierarchy.path": 1 });
db.templates.createIndex({ projectId: 1, "hierarchy.leafKind": 1 });
```

### Recommender flow

When the user starts to author a new template:

1. They pick the path step by step (S8 → OFW → FCB1 → OUTGOING).
2. After they pick the leaf kind (`motor` / `transformer` / …) and enter
   `kW` and `currentA`, the recommender runs:
   - **Exact path match** — fetch every template whose `hierarchy.path`
     equals the picked path.
   - **Refine by leafKind** — keep only those with the same leaf kind.
   - **Rank by parameter proximity** — score by `|kw - existing.kw|` and
     `|A - existing.A|`. Lowest score wins.
3. The user can pick a suggested template (copy it) or proceed to create
   a fresh one. The new template is saved with the full path attached
   so future authors see it as a suggestion.

This logic is a few dozen lines and lives in `chatbotTools.ts` so the
chatbot can call it too.

## 3. Chatbot — answers *and* actions at the same time

The chatbot was previously a "text in, text out" interface: it sent the
prompt to an HTTP endpoint and rendered the reply.

To let the assistant change app state — "change row 3's wiring to L03",
"set every wiringType M3 to M4", "create a new motor template at
S8/OFW/FCB1/OUTGOING for 22 kW" — we add a **tool-calling layer** on
the frontend.

### Wire format

The chatbot endpoint should return JSON with two fields:

```jsonc
{
  "reply": "I changed row 3 to L03 and updated 12 rows where wiring=M3 → M4.",
  "tool_calls": [
    { "name": "update_row",   "args": { "rowNumber": 3,  "column": "wiringType", "value": "L03" } },
    { "name": "bulk_update",  "args": { "where": { "column": "wiringType", "equals": "M3" }, "set": { "column": "wiringType", "value": "M4" } } }
  ]
}
```

Plain text replies still work for purely conversational answers.

### Tool registry

Defined in `src/services/chatbotTools.ts`. Each tool declares a name, a
JSON schema, and an `execute(args, ctx)` function that runs against the
app state. The chatbot:

1. Sends the prompt **and a snapshot of the visible context** to the
   backend.
2. Receives the reply + tool calls.
3. Executes each tool call locally against `ProjectContext`.
4. Renders the reply along with a summary of what happened.

### Initial tool set

The tools below cover the user stories in the spec:

| Tool                       | What it does                                                                |
|----------------------------|-----------------------------------------------------------------------------|
| `list_equipments`          | Returns the equipment tree for the current project                          |
| `list_rows`                | Returns rows in the active equipment (id, rowNumber, column values)         |
| `update_row`               | Mutates one column in one row                                               |
| `bulk_update`              | Mutates one column in every row matching a predicate                        |
| `add_row`                  | Appends a new row to the active equipment                                   |
| `set_cell_color`           | Highlights a cell                                                           |
| `set_row_color`            | Highlights a row                                                            |
| `apply_excel`              | Takes parsed Excel rows + a column mapping and writes them into the table   |
| `find_similar_templates`   | The recommender described in §2.3                                           |
| `create_template`          | Creates a template at a given hierarchical path with given properties       |

### The tab decides what a command means

The snapshot sent with every turn names the tab the user is on and what
that tab owns, and the system prompt puts it before anything else. An
instruction with no other subject is read against that screen: on Project
Definition "دما را ۵۰ کن" is `set_tech_setting general.designTemperature`;
the same words on Device Selection are about the rows. Whatever the
sentence names explicitly — a row number, an equipment, another tab — still
wins over the tab.

Without that rule the model reached for `bulk_update` for a temperature,
found no column of that name, and the user was told "Equipment not found"
about something that was never equipment.

The heuristic fallback in `src/services/intentParser.ts` follows the same
rule, so a command works the same way when the model returns prose instead
of an envelope. Two things that parser has to get right, and used to get
wrong: `\b` cannot bound a Persian word (it marks an ASCII word boundary, and
Persian letters are not ASCII word characters), and `\d` does not match
Persian digits — so every Persian command silently fell through. Terms are
matched through `term()` and the prompt is normalised to ASCII digits first.

### Nothing lands until an engineer says so

With **Review** on — the default — a tool call that would change the
project is not executed. It is staged into an approval card with one line
per change and an **Apply** button, and an engineer ticks what should
happen. Reads and navigation still run, so the answer above the card
describes the project as it really is.

`READ_ONLY_TOOLS` in `chatbotTools.ts` is what separates the two, and
`describeToolCall()` turns a call into the line shown on the card. Turning
Review off puts the assistant back to editing directly.

Applying several changes at once runs them back to back, with no React
render in between. Every tool therefore writes through
`patchProjectData(prev => …)` rather than deriving its patch from the
snapshot it was handed — otherwise the second change is computed from the
project as it was before the first, and the last write wins over all of
them.

### Safety

Tool execution mutates the project. Every tool reports a one-line
summary so the user sees what changed; the chatbot UI shows them inline
so destructive edits aren't silent.

### Which model answers

The assistant runs on the VLM (Qwen2.5-VL) served OpenAI-compatibly on
192.168.1.61. It is instruction-tuned and honours
`response_format: json_object`, which the tool-call contract needs — a
reasoning model narrates its thinking instead of answering in JSON, and the
app is left with nothing to execute.

`LOCAL_MODEL_URL` / `LOCAL_MODEL_NAME` in `.env` move it (compose passes
both through, so a different host or port is a restart, not a rebuild), and
the chat panel shows the model and host that answered the last turn —
"the AI is not working" is usually "the AI is not the one you think it is".

The **name** is not guessed. A vLLM server answers to whatever it was
launched with — a repo path, a tag, a shortened alias — and a wrong guess is
a 404 that reads like the whole assistant is down ("The model qwen2.5-vl-7b
does not exist"). So the backend asks `GET /v1/models` and uses what the host
actually serves: a configured `LOCAL_MODEL_NAME` wins when the server has it,
otherwise the served model does. A 404 re-asks and retries once, and if the
call still fails the error names every model the host does serve.

### One line, several commands

"سطح دریا 2000 و دما را بکن 50" is two instructions. Read as one sentence it
became a single setting with the other one's number attached, so
`intentParseAll` splits on "و" / "and" / commas and parses each clause, and a
value is taken from the number that follows *its own* term. The split is only
trusted when it yields more than one command, which keeps a value that
contains "and" (a project name, say) intact. A clause that reads as a
question is left alone entirely — answering it is the model's job, and acting
on it would turn "what is the client?" into a client named "the client".

### Backend contract

The backend that the chatbot is pointed at must:

- Accept `{ prompt, mode, files, context }` (the context being a
  serialised slice of `ProjectData`).
- Return `{ reply, tool_calls? }` as JSON.
- Stick to the tool names listed above; unknown names are rejected.

Any LLM with function-calling support (Claude, GPT-4 family, local
models via tool-use prompts) can produce this shape — the choice stays
flexible.

---

## The two LV systems, and the schematic beside the parts

Two things were added to this screen. Nothing was taken off it: every row,
column, dialog and rule described above works exactly as it did.

### SIVACON and CCS

LV templates are filed under a path, and the office reads the top of that path
as two different things — the SIVACON boards (8PT, S8) and the CCS side (OFW,
marshaling and the rest). The tree now lists them apart, and the wizard asks
which system first: pick SIVACON and it asks for the board root as it always
did; pick CCS and that step is skipped, because the CCS side has no board root
and its paths start at the group.

Which family a template belongs to is **worked out from the path it already
carries** (`utils/templateFamilies.ts`) — nothing is written into a template and
no existing one moves. `8PT / CCS` stays where it is, under SIVACON: it is the
CCS group of a SIVACON board, not the CCS side of the works. A template whose
path matches no family is not hidden either; it is listed on its own, where it
always was.

MV and HV have no families yet. That is one empty list in the same table, not a
special case anywhere, so giving them families later is adding rows to it.

### The schematic, as the parts go in

Beside the parts table there is now a panel showing what the single line will
draw for the part you are on. Add a part and it appears there; click through the
list and each symbol follows.

What decides the symbol is `symbolForPart` in `eplanSingleLine.ts` — **the same
function the single line uses**, so the preview is the drawing, not a second
opinion that agrees most of the time. It says which of the four answered:

1. a symbol chosen by hand on this part
2. what EPLAN's parts database says the part is
3. whether it reads as an accessory of the device above it
4. the part's own description, then the row it was filed under

Only the first is new. Choosing one stores `symbolId` on the part; clearing it
puts the automatic answer back.

### The graphic: one window, the whole template

The panel draws **the template**, not a part of it — the whole cell, put
together by the rule the sheets already use:

* the devices that carry power **in series** down the line, in the order a cell
  is drawn rather than the order the template filed its slots;
* the instruments hanging off it **in parallel**, each group starting level
  with the transformer that feeds it, through the test block where there is
  one;
* the shunts — arresters, dividers — beside the line with the earth under them.

It goes through the very same `splitBranch` and `drawBranch` the single line
uses (`buildTemplateSvg`), so it is not a second opinion about how a template is
drawn: it is what a feeder built on this template will look like.

**Open** puts that cell on the same canvas the sheets are edited on — one
window, for the template. Edits are kept with the project under
`template#<id>` and it exports as DXF, PDF or SVG, so a template can go out as
a typical drawing on its own. The sheets themselves still build from the parts.

### Redrawing one symbol

Editing a single symbol lives where the symbols do: **Simorgh Draw → Symbols**,
where clicking a card opens it on the graphic page. Saving keeps that drawing
with the project (`ProjectData.symbolOverrides`) and every sheet using the
symbol picks it up. The library's own symbol is never changed, and the
conductor's place across the symbol does not move — it is what puts the device
on the branch.

Project drawings are their own layer in the library, above the symbol pack, so
the template tab and the drawing tab cannot throw each other's symbols away.
