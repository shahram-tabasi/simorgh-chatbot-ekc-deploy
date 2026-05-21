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

### Safety

Tool execution mutates the project. Every tool reports a one-line
summary so the user sees what changed; the chatbot UI shows them inline
so destructive edits aren't silent.

### Backend contract

The backend that the chatbot is pointed at must:

- Accept `{ prompt, mode, files, context }` (the context being a
  serialised slice of `ProjectData`).
- Return `{ reply, tool_calls? }` as JSON.
- Stick to the tool names listed above; unknown names are rejected.

Any LLM with function-calling support (Claude, GPT-4 family, local
models via tool-use prompts) can produce this shape — the choice stays
flexible.
