---
name: simorgh-ui
description: How Simorgh Soft's screens look — colour, buttons, sections, contrast, dark mode — following UX best practice for engineering software. Use for any change to what a Simorgh Soft screen looks like (a new button, panel, card, badge, table, dialog, a colour or style choice), alongside the simorgh-soft skill. Not for drawings, symbols or exported sheets.
---

# Simorgh Soft — UI and colour

The owner's words: simple and elegant ("ساده و شیک"), like the Project
Definition tab — not colourful. This file turns that into rules, from UX
practice (NN/g, WCAG 2.2, the 60-30-10 rule, ISA-101 high-performance HMI)
and from what the owner has asked for on this app.

Everything in the simorgh-soft skill still holds — above all **change only
what was asked**: these rules shape what you build or touch, they are not a
licence to restyle screens nobody mentioned. Propose that instead.

## The principle: colour is a signal, not decoration

An engineer reads this app for hours against drawings that are themselves
black and white. Colour spent on decoration costs the colours that mean
something. So, as on a high-performance HMI:

- **Neutral by default.** White and grey surfaces, grey borders, dark grey
  text. Roughly 60 % background, 30 % greys (panels, headers, cards),
  10 % accent.
- **One accent for action: blue.** The brand blue of the logo. It marks the
  *one* primary action of a screen or dialog, the active tab, links, focus,
  and selection. Nothing else is blue.
- **Status colours mean status, and nothing else.** Red = error / destructive
  / blocked. Amber = warning, attention, edited-not-saved. Green = done /
  success / passed. Never a red PDF button, a green Excel button, a purple
  HTML button: a file type is not a status.
- **Never colour alone.** Every coloured state also has text or an icon
  (colour-blind users, greyscale printouts, the dark theme). Check a screen
  in greyscale: if something stops making sense, it was relying on colour.

## Tokens — use these classes

The dark theme is `theme.css` remapping light Tailwind classes under
`[data-theme="dark"]`. **Use only classes it remaps** (listed in it) and
**never inline hex colours** (`style={{ background: '#…' }}`): an inline
colour stays light on the dark page — it happened on Output Types.

| Role | Classes |
|---|---|
| Page / panel surface | `bg-white`, `bg-gray-50` (panel headers, cards) |
| Borders | `border-gray-200` (panels, cards), `border-gray-300` (buttons) |
| Text | `text-gray-800`/`900` main, `text-gray-600`/`500` secondary — never `text-gray-400` for anything that must be read (2.5:1, fails WCAG) |
| Accent (primary action, active) | `bg-blue-600 hover:bg-blue-700 text-white`; `text-blue-700`, `bg-blue-50 border-blue-200` for a selected row/item |
| Error / destructive | `text-red-700`, `bg-red-50 border-red-200`; a destructive confirm button `bg-red-600 text-white` |
| Warning | `text-amber-800`, `bg-amber-50 border-amber-200` |
| Success | `text-green-700`, `bg-green-50 border-green-200` |

Measured contrast (WCAG AA wants 4.5:1 for text, 3:1 for UI components):
white on blue-600 5.2, on red-600 4.8; gray-700 on white 10.3, gray-500
4.8, gray-400 2.5 ✗; amber-700 on amber-50 4.8, green-700 on green-50 4.8.
An input's edge needs 3:1 — `border-gray-300` (1.5) is decoration only, so
a text field keeps `border-gray-300` *and* a clear focus ring
(`focus:border-blue-500 focus:ring-1 focus:ring-blue-500`) or a darker
border. Dark mode: aim above the minimum; light grey on dark blurs sooner.

## Buttons — three tiers, one look each

1. **Primary** — the one thing the screen is for (Next, Save, Apply, Add in
   a dialog): `px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700`.
   At most one per screen or dialog.
2. **Secondary** — every other command (Import, Export, Fullscreen, Excel,
   PDF, Compare…): `px-3 py-1 border border-gray-300 bg-white text-gray-700
   rounded text-sm hover:bg-gray-50`, an icon before the label.
   A toggle that is on: `bg-gray-100` (not a colour).
3. **Tertiary / icon** — close, collapse, row actions:
   `p-1 rounded text-gray-500 hover:bg-gray-100`, with a `title`.

Destructive actions are secondary until the confirm step, where the confirm
button is red. Disabled: `disabled:opacity-50`, with a `title` that says why.

## Sections, cards, badges

- **Collapsible sections start closed** and open from their own arrow
  (`ChevronRight` closed, `ChevronDown` open). A screen opens calm; the
  user chooses what to read. Remember what they opened, not the reverse.
- **Badges and section numbers are grey** —
  `bg-gray-100 text-gray-600 border border-gray-200 rounded-full text-xs font-bold`.
  A badge is colour only when it *is* a status (LV/MV tier pills are a
  known exception the owner has seen and left).
- **Summary cards**: `bg-white border-gray-200`, label `text-gray-500
  uppercase text-xs`, value `text-gray-800 font-bold`. Not one colour per card.
- **Table headers**: `bg-gray-100 text-gray-700` (a second tone `bg-gray-200`
  where two header groups must be told apart). Not dark or coloured bands.
- Related cards sit **side by side** on a wide window and stack on a narrow
  one: `grid grid-cols-1 lg:grid-cols-2 gap-3`.

## Say it once — no repetition, explanations on hover

The owner's words: bring clutter and repetition to zero.

- **The app header says it once.** Project name, revision, standard, save
  status and the Simorgh Draw button live in the header; File / Edit / View /
  Help sit at the start of the tab row. A tab never repeats the project name
  or its own tab name as a heading, and no command appears twice on one screen
  (the header's Simorgh Draw button replaced the one on the Simorgh Draw tab).
- **What a thing is for goes on hover** (`title`), not as a grey line under
  it: PanelFrame's `note` is the heading's tooltip; card and tab subtitles,
  footnotes and long empty-state paragraphs become the `title` of the control
  they explain. The full explanation lives in Help (`public/help.html`) —
  update it when a screen changes.
- **Not on hover:** status and warnings (save failed, read-only, missing
  symbols) and data. The specs under each section in Create Template's tree
  ("Motor, Feeder, MODULLAR · 0") stay visible — the owner asked for that.

## Placement

- A panel's own commands go **in its header, at the right end** (Fullscreen
  on Scope Specifications). One control per job: the button that enters a
  mode is the button that leaves it — no second "exit" button elsewhere.
- Primary action bottom-right of a page or dialog (Next →), Cancel to its
  left as a secondary button.

## Before you push a UI change

1. Build the throwaway preview (simorgh-soft skill, "Seeing it in a
   browser") with a real project, screenshot it **light and dark**, wide
   (1500) and narrow (1000).
2. Look for: a new colour that is not a status or the one accent; an inline
   hex colour; `text-gray-400` on something meant to be read; more than one
   blue button; a section open by default.
3. Delete the preview files.

Sources: NN/g, "Using Color to Enhance Your Design"; WCAG 2.2 SC 1.4.3 /
1.4.11; ISA-101 high-performance HMI practice (grey base, colour only for
abnormal states); the 60-30-10 rule for UI palettes.
