# Panels, and the type the suite is set in

Two things that touch every screen: which panels are on it, and what it is
written in.

## Panels

A panel is a *view* of something the project already holds — the template
graphic, the assistant — never the only copy of anything. That is what makes it
safe to put away, and EPLAN works the same way: a navigator is closed when it is
in the way and reopened from a menu when it is wanted.

There are two different gestures, kept apart on purpose:

| | What it does | Where it lives |
|---|---|---|
| **Collapse** (the chevron) | Rolls the body up, leaves the title bar. The panel still holds its place. | Local to the panel |
| **Close** (the ×) | Takes it off the screen; the row beside it gets the width. | Remembered per person |

A closed panel renders **nothing** — no rail, no stub. That is the point: a
48-pixel stub is 48 pixels the workspace could be using. What it costs is that
something else has to know the panel exists, which is the registry.

### The registry

`src/context/PanelsContext.tsx`. A panel registers itself the first time it
renders and **stays registered for the rest of the session even while hidden**,
so `View → Panels` can always list it. Without that rule, closing the last panel
of a kind would hide the very control that reopens it.

Adding a panel is one component:

```tsx
<PanelFrame
  id="template-graphic"          // stable — it is the key the state is kept under
  title="Template graphic — گرافیک تمپلیت"
  group="Create Template"        // the heading it sits under in the menu
  note="The whole cell, drawn the way a feeder built on it will be."
>
  …
</PanelFrame>
```

That is all: the menu entry, the collapse, the close and the remembering come
with it. A panel that draws its own chrome — the assistant does, it is a
gradient column with its own title bar — calls `usePanel()` instead and returns
`null` when it is closed.

What is closed is kept in `localStorage` under `simorgh-panels`, and **only
closures are stored**: a panel nobody has heard of is open. So a panel added in
a later version appears the first time rather than staying mysteriously hidden.

It is kept in the browser rather than in the project on purpose. Two engineers
on one project have different screens and different habits, and neither should
be rearranging the other's workspace by saving.

### What is a panel

Five so far, and adding a sixth is one component:

| Panel | Screen |
|---|---|
| Simorgh AI | everywhere |
| Project Templates | Create Template |
| Template graphic | Create Template |
| Templates | Device Selection |
| Equipment Tree | Device Selection |

A panel that shares a row has to give its width back when it closes, and only
the parent knows how the row is built — so the parent asks `usePanel` the same
question the panel does and sizes itself from the answer. Device Selection
builds its `gridTemplateColumns` from which of its two side columns are open;
Create Template swaps `w-3/4` for `w-full`. A closed panel leaves no track
behind it, which is the difference between the workspace gaining the width and
the workspace gaining a gap.

### Which way it folds

A panel stacked above or below its neighbours **rolls up**, keeping its title
bar. A panel *beside* them — a tree down the left, a schematic down the right —
**folds sideways** to a 36px rail with its name written up it. `side="left"` or
`side="right"` is what says so.

The distinction is not decoration. Folding a docked panel upwards would leave a
full-width title bar sitting on nothing and give the table beside it no width at
all — the one thing folding was supposed to buy.

For the width to actually come back, the parent's track has to be able to
shrink: Device Selection's side columns are `auto` and the panels carry their
own width, so the track follows the panel down to 36px and vanishes when it
closes. Create Template's properties are `flex-1`, which fills whatever the
tree leaves — three quarters, a rail, or nothing.

### The workspace

The content band runs to the edges of the window rather than sitting in a
centred `container`. A parts table, a device matrix and a drawing all want the
width — and when a panel beside them is closed they should get the room it gave
up, which a capped container would have left as grey margin instead.

The parts table carries `min-w-[1180px]` inside an `overflow-x-auto` box. Nine
columns of fixed width plus the part name genuinely need that much; without the
minimum the table squeezed itself into whatever the schematic left it, and with
`overflow-hidden` the far columns could not be reached at all.

## Language

The suite is in **English**, everywhere, with one exception: Simorgh Draw's own
editor, which has an EN / فا / TR switch on its toolbar and the guide behind it
(`src/components/SimorghDraw/lang.ts`, `public/help-drawing.html`). That is the
only place another language appears, and it appears because the person chose it.

Two things that look like exceptions and are not:

- **`src/services/intentParser.ts`** matches what a person *types* to the
  assistant. Its Persian is input, not output — deleting it would stop the
  assistant understanding a Persian sentence.
- **`IEC_SYMBOLS[...].titleFa`** is still on every symbol. Nothing renders it
  any more, but the data stays: it costs nothing, and a Persian symbol sheet is
  a switch away rather than a retyping job.

## Type

`src/fonts.css`. Three faces, in the order the office asked for them:

| Face | How it gets here | Why |
|---|---|---|
| **IRANSansX** | `local()` only | Licensed from Fontiran — not ours to redistribute |
| **Peyda** | `local()` only | Same |
| **Vazirmatn** | Bundled, `public/fonts/` | SIL Open Font Licence, so it can ship |

The stack is ordered so an office that has bought IRANSansX or Peyda sees its
own house face, and everyone else still gets a proper Persian face rather than
the browser's default — which on Windows means Tahoma and on a Linux print
server often means nothing at all. Each `local()` lists every name a Windows or
macOS installation might register the face under; a name that is not installed
simply does not match and the stack moves on.

Vazirmatn ships as one variable file (111 KB) covering weights 100–900, which is
smaller than the three static cuts it replaces and lets the UI use 500 and 600
without another download. The static cuts are declared after it under a separate
family name, so a browser that understands variations never fetches them.

Tailwind's `font-sans` points at the stack through `--simorgh-font-fa`, so every
existing class picked it up without a single component changing.

Two deliberate details:

- **Numbers stay Latin.** `font-variant-numeric: lining-nums tabular-nums`. A
  rating, a part number and a module position are read against a datasheet, and
  ۳۲ sitting next to 32A on the same page is a misreading waiting to happen.
- **Drawings are unaffected.** `DrawingCanvas` and `renderSvg` set their own
  font explicitly, so a sheet exported today looks like one exported last week.
  The round-trip regression proves it: still pixel-identical.
