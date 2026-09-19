---
name: simorgh-soft
description: Working on Simorgh Soft — the Design Suite at simorgh-agent/simorgh-soft (Simorgh Draw, the symbol library, the page tree, device selection, templates, Send to EPLAN). Use for any change to that app: where it lives, how to check a change before pushing, how to see a UI change in a real browser, the drawing rules a symbol must obey, and how it is deployed. Not for the chatbot services under simorgh-agent/*-service.
---

# Simorgh Soft

The electrical design suite: a switchgear project goes in as device selection
and templates, and single lines, wiring diagrams, panel layouts and an EPLAN
handover come out. **Simorgh Draw** is the drawing side of it — the canvas, the
page tree, the symbol library, the assistant.

## Where things are

Everything is under `simorgh-agent/simorgh-soft/`:

| Path | What |
|---|---|
| `simorgh-frontend/src/components/SimorghDraw/` | the editor, page tree, symbol library, symbol pages |
| `simorgh-frontend/src/components/Eplanix/EplanixTab.tsx` | the Simorgh Draw tab — the way in |
| `simorgh-frontend/src/utils/cad/` | geometry, shapes, DXF/SVG/PDF back-ends, pages, symbol sources |
| `simorgh-frontend/src/utils/iecSymbols.ts` | the built-in single-line library |
| `simorgh-frontend/src/utils/cad/wdSymbols.ts` | the wiring-diagram library |
| `simorgh-frontend/src/components/PLC/` | the PLC page — tree, editors, instruction catalogue, assistant |
| `simorgh-frontend/src/utils/plc/` | the program model, the instruction catalogue, the checker, the SCL exporter |
| `simorgh-backend/` | Express + Mongo: projects, the office symbol library, EPLAN bridges |

`simorgh-agent/frontend` is a **different app** (the chatbot). Don't edit it for
a Simorgh Soft request.

## Checking a change

From `simorgh-agent/simorgh-soft/simorgh-frontend` (`npm ci` first if there is
no `node_modules`):

```bash
npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c 'error TS'   # expect 22
npx eslint src/components/SimorghDraw/                        # expect 2 errors
npx vite build                                                # must be clean
```

**The 22 tsc errors and the 2 eslint errors are the baseline** — `import.meta.env`
typing, unused vars, a `PropertyValue` mismatch in the template tab. They were
there before and are not yours. Count before and after; the number must not go
up. Don't "fix" them as a side quest.

## Seeing it in a browser — do this for any UI change

Typecheck says nothing about a panel whose canvas is cut off or a button pushed
off the edge. Every UI bug reported against this app so far was a layout bug
that compiled perfectly. Build a throwaway harness, look at it, then delete it:

```bash
cd simorgh-agent/simorgh-soft/simorgh-frontend
# src/__preview.tsx mounts the component inside <ProjectProvider>;
# preview.html loads /src/__preview.tsx
npx vite --port 5199 --strictPort &
# the dev server serves it under the app's base path:
#   http://localhost:5199/simorgh-design-suite/preview.html
```

Drive it with Playwright — Chromium is already on the box, don't install one:

```js
chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
```

Screenshot at several sizes (1600, 1280, 1100, 860, 700 wide) **and** with the
editor in its own full screen. Delete `src/__preview.tsx` and `preview.html`
before committing.

For symbols there is a faster path — render them straight from the source with
esbuild, no app needed:

```bash
npx esbuild render.mjs --bundle --platform=node --format=esm --outfile=out.mjs && node out.mjs
```

## Rules the code keeps

**A symbol never joins its own terminals.** A breaker, disconnector, contactor
or switch is drawn *open* — that is what the symbol means, the state it sits in
until something operates it. Nothing may draw a conductor from one terminal to
the other past an open blade: not the library, not an override, not a redraw,
not the office's DXF pack. `drawIecSymbol` places geometry and adds nothing;
only a *picture* override gets a lead, because a letterboxed image has no
geometry to connect to.

**The conductor's place does not move.** `pinX` is where the branch line runs
through a symbol. A symbol redrawn on the symbol page keeps it, or the device
lands beside the wire instead of on it.

**`lang.ts` is three languages.** `Strings` is an interface; en, fa and tr each
implement it, so a key added to one and not the others is a type error. Write
all three. The toolbar keeps its left-to-right order in every language; only
running text turns for Persian (`dirOf`).

**Full screen is the browser's own.** The editor calls `requestFullscreen` on
its frame, and the browser paints only that element's subtree. Anything
portalled to `document.body` mounts, takes clicks and is invisible. Overlays use
`useOverlayHost()` (`components/SimorghDraw/overlayHost.ts`). z-index cannot fix
this and did not.

**An embedded editor fills its box.** `DrawingEditor`'s canvas is 620px tall
unless `embedded` is set; inside a shorter panel that puts half the drawing and
the Save button below the window. Pass `embedded`; pass `lean` as well when the
host owns full screen and the symbol library.

**A feeder number is not unique.** A busbar section carries many rows under
one number, and this office's sheets do. Anything matching Excel rows to table
rows queues them per number and claims each table row once — one table row per
sheet row, and a number the table does not have is a new row. Matching on a
number as if it were a key silently threw sixteen rows away and called them
deleted.

**A placed symbol carries its id** (`Pen.symbol`), so a symbol redrawn for the
project can replace the ones already on the sheets (`utils/cad/replaceSymbol.ts`).
Keep stamping it when adding a new way to place a symbol.

Comments here explain *why*, in prose, and are worth keeping — match that.

## The PLC page

A TIA-Portal-shaped programming environment, kept with the project under
`projectData.plc`. Tree on the left, block in the middle, instruction
catalogue or assistant on the right, problems underneath.

**A rung is a tree, never geometry.** LAD and FBD are the ladder model this
app already had (`utils/ladder/model.ts`): groups in series, branches in
parallel, elements in series inside a branch. That is what lets the same
network be drawn, checked, compiled to SCL and handed to a model. A graphical
language stored as free geometry can be none of those. Every edit goes
through `utils/plc/ladderEdit.ts`, whose functions each return a rung that is
still legal — nothing splices a group's branches by hand.

**The reader keeps a half-typed row.** Every edit goes out through the project
and back in through `readPlcProject`, so a row dropped for having no name yet
is a row that cannot be added at all: press Add, get nothing, every time. The
checker says a row is unfinished; the reader does not throw it away.

**Monaco is loaded on demand.** Three megabytes, on one page. `PlcTab` is
`React.lazy` and the editor itself is imported inside `monacoSetup.ts`, so the
main bundle is the size it was. The ESM deep paths (`editor.all`,
`editor.api`) are used rather than the package root, which leaves out eighty
languages and the TypeScript service. Providers are registered **once** — they
are per language, not per editor, and registering them on mount stacks a copy
per block opened.

**Light utilities only, as everywhere else here.** Tailwind's `dark:` variant
is not configured; `theme.css` remaps the light classes under
`[data-theme="dark"]`. Use the tints it names (`bg-blue-50`, `bg-amber-50/60`)
— a slashed tint it does not name stays near-white on a dark page.

**A panel that appears must not move what is under the pointer.** The armed-
instruction strip in the catalogue used to appear only when something was
picked, which pushed the list down between the two clicks of a double click:
picking TON gave a Set coil. It is always on screen now.

**Nothing here talks to a controller.** The page writes, checks and exports;
it does not claim to produce a file TIA will import unchanged and it does not
download to a rack. The assistant's answers are drafts for an engineer to
read, and the panel says so where the work is handed over.

## Shipping

Push to the working branch. GitHub Actions (`Build simorgh-soft`) builds the
image on any change under `simorgh-agent/simorgh-soft/**`. Then, on the server:

```bash
cd ~/simorgh-chatbot-ekc-deploy && git pull && ./deploy-soft.sh
```

That pulls the one image and recreates the one container — no build, nothing
else restarted. It prints the running commit from `build.json`; check it matches
what was pushed. **Say to hard-refresh (Ctrl+Shift+R)**: the change is in the
frontend bundle, and a cached bundle looks exactly like a failed deploy.

**A menu goes in `MenuBox`.** `src/components/shared/MenuBox.tsx` measures the
menu and moves it up or left to fit. Placing one at the click and leaving it
there puts the commands off the bottom edge of the screen, which reads to
somebody using it exactly like a command that does nothing.

**A template keeps its id.** Its path, its leaf, its parameters and its name
are all edited in place — `moveTemplate` — because the device rows in Device
Selection point at that id. Rebuilding a template to correct one answer
detaches every row built on it.
