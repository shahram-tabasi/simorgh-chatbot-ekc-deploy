// src/components/SimorghDraw/lang.ts
//
// Simorgh Draw in three languages: English, Persian and Turkish.
//
// The office that draws these boards works in Persian, the company sells from
// Turkey, and the customer who opens the DXF could be anywhere — so the editor
// says what it does in whichever of the three the person at the keyboard reads.
// The choice is remembered in the browser, because it belongs to the person and
// not to the project.
//
// The toolbar keeps its left-to-right order in every language. A CAD toolbar is
// a row of pictures, not a sentence, and every package a draughtsman here has
// ever used runs it the same way round; only the running text — panels, hints,
// help — turns for Persian. `LANGS[l].dir` is what says so.

export type Lang = 'en' | 'fa' | 'tr';

export const LANGS: { id: Lang; label: string; dir: 'ltr' | 'rtl' }[] = [
  { id: 'en', label: 'EN', dir: 'ltr' },
  { id: 'fa', label: 'فا', dir: 'rtl' },
  { id: 'tr', label: 'TR', dir: 'ltr' },
];

export const dirOf = (l: Lang): 'ltr' | 'rtl' => LANGS.find(x => x.id === l)?.dir ?? 'ltr';

/** Every phrase the editor shows. A key missing anywhere is a type error. */
export interface Strings {
  // Tools
  select: string; pan: string; line: string; polyline: string; rect: string;
  circle: string; ellipse: string; arc: string; text: string; dim: string;
  trim: string; extend: string; corner: string;

  // View and history
  zoomIn: string; zoomOut: string; fit: string; zoomSel: string;
  undo: string; redo: string; duplicate: string; del: string; revert: string;

  // Keeping the work
  save: string; savedAlready: string; cannotKeep: string; readOnly: string;
  discardAll: string; discardAllTip: string;

  // Drawing aids
  grid: string; noSnap: string; snapTo: string;
  osnapOn: string; osnapOff: string;
  fullscreen: string; leaveFullscreen: string; help: string; closeHelp: string;

  // Modifying
  modify: string;
  rotateCW: string; rotateCCW: string; rotateFree: string;
  mirrorH: string; mirrorV: string; scale: string;
  alignLeft: string; alignRight: string; alignTop: string; alignBottom: string;
  centreX: string; centreY: string;
  spreadX: string; spreadY: string;
  toFront: string; toBack: string;

  // Style
  layerOf: string; widthOf: string; lineTypeOf: string; textHeightOf: string;
  connect: string;
  xlsxImport: string; xlsxImportTip: string;
  xlsxUpdate: string; xlsxUpdateTip: string;
  xlsxEmpty: string; xlsxUnreadable: string; xlsxGone: string;
  wireNumber: string; wireNumberTip: string; wireNumbered: string;
  wireAllNumbered: string; wireNoneFound: string;
  tagDevices: string; tagDevicesTip: string; tagged: string; tagAllTagged: string;
  checks: string; checksTip: string; checksClean: string;
  xrefs: string; xrefOn: string;
  colourOfPicked: string; colourOfNew: string; colourClear: string; colourClearShort: string;
  ask: string; askTip: string; askPlaceholder: string; askNote: string;
  askGo: string; askWorking: string; askDrew: string; askDrewSome: string; askFailed: string;
  solid: string; dashed: string; dashDot: string; dotted: string;
  paperOf: string; fitDrawing: string;
  header: string; headerTip: string; headerOff: string; headerTooSmall: string;
  headerFitted: string;

  // The ribbon — its tabs, and the caption under each group of commands
  tabHome: string; tabElectrical: string; tabOutput: string; tabView: string;
  panDraw: string; panModify: string; panArrange: string; panProps: string;
  panBlock: string; panAnnotate: string; panCheck: string; panTable: string;
  panSheet: string; panExport: string; panKeep: string;
  panZoom: string; panAids: string; panApp: string;

  // Geometry, in the panel where it can be typed
  geometry: string; inMm: string;
  lengthOf: string; angleOf: string; radiusOf: string;
  startX: string; startY: string; endX: string; endY: string;
  centreXOf: string; centreYOf: string; widthMm: string; heightMm: string;
  radiusXOf: string; radiusYOf: string; sweepFrom: string; sweepTo: string;
  atX: string; atY: string; rotationOf: string;
  pointsN: (n: number) => string;
  dragGrips: string;

  // Blocks, and the library they come from
  group: string; ungroup: string; blocksN: (n: number) => string;
  inBlock: string; needTwoToGroup: string; nothingToUngroup: string;
  openLibrary: string;
  libTitle: string; libNote: string; libSearch: string; libNoneFound: string;
  libFromFile: string; libFromFileNote: string; libImport: string;
  libAsBlock: string; libPickOne: string; libDoubleClick: string;
  libNothingIn: (name: string) => string;
  libPlaced: (name: string) => string;

  // Light or dark
  themeLight: string; themeDark: string;

  // Panels
  layers: string; selection: string; typeOf: string; textOf: string;
  pickedN: (n: number) => string;
  nothingPicked: string;
  showLayer: string; hideLayer: string; lockLayer: string; unlockLayer: string;
  appliesToPicked: string;

  // Status bar
  shapesN: (n: number) => string;
  zoomPct: (n: number) => string;
  edited: string; notKept: string; keptWithProject: string;
  staleN: (n: number) => string;
  nothingToDraw: string;

  // What to do now
  hintIdle: string; hintText: string; hintPolyline: string; hintTwoClicks: string;
  hintDim: string; hintTrim: string; hintExtend: string;
  hintCornerFirst: string; hintCornerSecond: string;

  // When a command cannot do what was asked
  needALine: string; noCrossing: string; areParallel: string;

  // Prompts
  promptText: string; promptRotate: string; promptScale: string; promptRadius: string;
  cornerRadius: string;

  // Help
  helpTitle: string; helpIntro: string;
  helpDrawing: string; helpModify: string; helpKeys: string; helpTips: string;
  helpFullGuide: string;
  helpLines: Record<'draw' | 'modify' | 'keys' | 'tips', string[]>;
}

const EN: Strings = {
  select: 'Select', pan: 'Pan — or hold Space', line: 'Line',
  polyline: 'Polyline — Enter, right-click or double-click ends it',
  connect: 'Connect — two points, wired square on the WIRE layer, with a dot where it taps an existing run',
  xlsxImport: 'Excel',
  xlsxImportTip: 'Draw a spreadsheet on the sheet as a table, on the TABLE layer',
  xlsxUpdate: 'Update',
  xlsxUpdateTip: 'Read the same file again and redraw this table where it sits',
  xlsxEmpty: 'That spreadsheet has no rows to draw.',
  xlsxUnreadable: 'Could not read that file — it should be .xlsx, .xls or .csv.',
  xlsxGone: 'Could not read the file again — it may have been moved or renamed.',
  wireNumber: 'Number wires',
  wireNumberTip: 'Give every net a number and write it on the wire. Wires already numbered are left alone.',
  wireNumbered: '{n} wire(s) numbered.',
  wireAllNumbered: 'Every wire already carries a number.',
  wireNoneFound: 'No wires to number on this sheet.',
  tagDevices: 'Designate',
  tagDevicesTip: 'Give every undesignated symbol an IEC designation, carrying on from the highest already used.',
  tagged: '{n} device(s) designated.',
  tagAllTagged: 'Every device already carries a designation.',
  checks: 'Checks',
  checksTip: 'Look over the sheet: open wire ends, repeated designations, crossings with no junction dot.',
  checksClean: 'Nothing to report on this sheet.',
  xrefs: 'Across sheets',
  xrefOn: 'on',
  colourOfPicked: 'Colour of what is picked (SVG and PDF only — CAD takes colour from the layer)',
  colourOfNew: 'Colour of what is drawn next',
  colourClear: 'Back to the layer colour',
  colourClearShort: 'Layer',
  ask: 'Draw for me',
  askTip: 'Describe a circuit and the local model drafts it onto this sheet',
  askPlaceholder: 'e.g. a motor starter: isolator, fuses, contactor, overload, motor — wired down the page',
  askNote: 'A first draft to correct, not an answer. It arrives as one undo step, so it can be taken straight back off.',
  askGo: 'Draw',
  askWorking: 'Drawing…',
  askDrew: '{n} shape(s) drawn.',
  askDrewSome: '{n} shape(s) drawn — {d} were dropped as unusable, so look it over.',
  askFailed: 'The model could not draw that.',
  rect: 'Rectangle', circle: 'Circle — centre, then radius',
  ellipse: 'Ellipse — centre, then the two radii',
  arc: 'Arc — centre, start, then sweep', text: 'Text',
  dim: 'Dimension — from, to, then where the line sits',
  trim: 'Trim — click the part of a line to cut away',
  extend: 'Extend — click the end of a line to run it on',
  corner: 'Corner — click two lines to bring them together',

  zoomIn: 'Zoom in', zoomOut: 'Zoom out', fit: 'Fit the sheet (F)',
  zoomSel: 'Zoom to selection',
  undo: 'Undo (Ctrl+Z)', redo: 'Redo (Ctrl+Shift+Z)',
  duplicate: 'Duplicate (Ctrl+D)', del: 'Delete (Del)',
  revert: 'Revert this sheet to as drawn',

  save: 'Keep these edits with the project (then save the project)',
  savedAlready: 'The project already holds these edits',
  cannotKeep: 'These edits cannot be kept with this project',
  readOnly: 'This revision is view-only — raise a revision to keep edits',
  discardAll: 'Discard all',
  discardAllTip: 'Put every sheet back to as drawn, in the project too',

  grid: 'Show the grid', noSnap: 'no snap', snapTo: 'Snap moves and new points to this step',
  osnapOn: 'Catching the ends and corners of what is drawn — click to stop',
  osnapOff: 'Not catching the ends and corners of what is drawn',
  fullscreen: 'Full screen', leaveFullscreen: 'Leave full screen (Esc)',
  help: 'How to draw with this (F1)', closeHelp: 'Close',

  modify: 'Modify',
  rotateCW: 'Turn 90° clockwise', rotateCCW: 'Turn 90° anticlockwise',
  rotateFree: 'Turn by an angle', mirrorH: 'Mirror left to right',
  mirrorV: 'Mirror top to bottom', scale: 'Scale by a factor',
  alignLeft: 'Align left', alignRight: 'Align right',
  alignTop: 'Align top', alignBottom: 'Align bottom',
  centreX: 'Centre across', centreY: 'Centre down',
  spreadX: 'Even out the gaps across', spreadY: 'Even out the gaps down',
  toFront: 'Bring to front', toBack: 'Send to back',

  layerOf: 'The layer new geometry goes on', widthOf: 'Line weight',
  lineTypeOf: 'Line type', textHeightOf: 'Text height, in drawing units',
  solid: 'solid', dashed: 'dashed', dashDot: 'dash-dot', dotted: 'dotted',
  paperOf: "The sheet DXF and PDF are put on. 'Fit the drawing' keeps the scale and lets the sheet grow.",
  fitDrawing: 'fit the drawing',
  header: 'Header',
  headerTip: 'Frame, zone grid and title block, put on the sheet as real geometry: it draws, plots and exports like the rest of it, and any cell can be retyped',
  headerOff: 'On the sheet. Press again to take the frame, the zone grid and the title block off.',
  headerTooSmall: 'This sheet is too small to carry a frame.',
  headerFitted: 'The drawing was brought down to {n}% to sit inside the frame. Undo if you would rather move it yourself.',
  tabHome: 'Home', tabElectrical: 'Electrical', tabOutput: 'Output', tabView: 'View',
  panDraw: 'Draw', panModify: 'Modify', panArrange: 'Arrange', panProps: 'Properties',
  panBlock: 'Block', panAnnotate: 'Annotate', panCheck: 'Check', panTable: 'Table',
  panSheet: 'Sheet', panExport: 'Export', panKeep: 'Keep',
  panZoom: 'Zoom', panAids: 'Aids', panApp: 'App',

  geometry: 'Geometry', inMm: 'millimetres',
  lengthOf: 'Length', angleOf: 'Angle', radiusOf: 'Radius',
  startX: 'Start X', startY: 'Start Y', endX: 'End X', endY: 'End Y',
  centreXOf: 'Centre X', centreYOf: 'Centre Y', widthMm: 'Width', heightMm: 'Height',
  radiusXOf: 'Radius X', radiusYOf: 'Radius Y', sweepFrom: 'From', sweepTo: 'To',
  atX: 'X', atY: 'Y', rotationOf: 'Rotation',
  pointsN: n => `${n} points`,
  dragGrips: 'Drag a square handle to move that end on its own; the diamond carries the whole shape. Hold Shift to keep it level, upright or on 45°.',

  group: 'Group into a block (Ctrl+G)',
  ungroup: 'Break the block apart (Ctrl+Shift+G)',
  blocksN: n => `${n} block${n === 1 ? '' : 's'}`,
  inBlock: 'In a block — picking one part takes the whole of it',
  needTwoToGroup: 'Pick two or more shapes to group them',
  nothingToUngroup: 'Nothing picked is in a block',
  openLibrary: 'Symbol library — place a symbol, or bring one in from a file',
  libTitle: 'Symbol library',
  libNote: 'Place a symbol on the sheet, or bring one in from this computer. Everything arrives as one block.',
  libSearch: 'Search symbols…',
  libNoneFound: 'Nothing matches that.',
  libFromFile: 'From a file',
  libFromFileNote: 'Read a DXF or SVG off this computer and place it',
  libImport: 'Place on the sheet',
  libAsBlock: 'It arrives as one block, in the middle of the view. Drag it where it belongs; break it apart from the toolbar if you need the pieces.',
  libPickOne: 'Pick a symbol to see it larger and place it. Double-click one to place it straight away.',
  libDoubleClick: 'double-click to place',
  libNothingIn: name => `There is no geometry in ${name}`,
  libPlaced: name => `${name} placed as a block — drag it where it belongs`,

  themeLight: 'Light', themeDark: 'Dark',

  layers: 'Layers', selection: 'Selection', typeOf: 'Type', textOf: 'Text',
  pickedN: n => `${n} shapes`,
  nothingPicked: 'Click something to pick it, or drag a box around several. Double-click a label to retype it.',
  showLayer: 'Show this layer', hideLayer: 'Hide this layer',
  lockLayer: 'Lock this layer', unlockLayer: 'Unlock this layer',
  appliesToPicked: 'Changing any of these redraws what is picked.',

  shapesN: n => `${n} shapes`,
  zoomPct: n => `zoom ${n}%`,
  edited: 'edited', notKept: 'not kept yet', keptWithProject: 'kept with the project',
  staleN: n => `${n} sheet${n === 1 ? '' : 's'} edited against an older drawing`,
  nothingToDraw: 'Nothing to draw yet.',

  hintIdle: 'Space pans · wheel zooms · F fits · Ctrl+Z undoes · F1 for help',
  hintText: 'Click where the text goes',
  hintPolyline: 'Click each corner · Backspace takes one back · Enter, right-click or double-click ends it · Esc cancels',
  hintTwoClicks: 'Click, then click again · Shift squares it up · right-click or Esc cancels',
  hintDim: 'Click what it measures from, then to, then where the line sits',
  hintTrim: 'Click the piece of a line to cut away — it is cut at what crosses it',
  hintExtend: 'Click the end of a line to run it on to the next thing in its way',
  hintCornerFirst: 'Click the first line, on the side you want to keep',
  hintCornerSecond: 'Now the second line, on the side you want to keep',

  needALine: 'That works on straight lines',
  noCrossing: 'Nothing in the way to run it on to',
  areParallel: 'Those two are parallel — they have no corner',

  promptText: 'Text', promptRotate: 'Turn by how many degrees?',
  promptScale: 'Scale by what factor?', promptRadius: 'Corner radius, in drawing units (0 for a sharp corner)',
  cornerRadius: 'Corner radius',

  helpTitle: 'Drawing with Simorgh Draw',
  helpIntro: 'The sheet is geometry, not a picture — everything on it can be picked, moved, restyled and cut, and DXF, PDF and SVG all come off what you see.',
  helpDrawing: 'Drawing', helpModify: 'Changing what is there',
  helpKeys: 'Keys', helpTips: 'Worth knowing',
  helpFullGuide: 'Open the full guide',
  helpLines: {
    draw: [
      'Pick a tool, then click where the shape starts and click again where it ends. Dragging works too — press, move, release.',
      'A polyline takes as many clicks as you like. Backspace takes the last point back, Enter or a right-click or a double-click finishes it, Esc drops it.',
      'An arc is three clicks: the centre, where it starts, then how far it sweeps.',
      'A dimension is three clicks: what it measures from, what it measures to, then where the dimension line sits. The label is written in millimetres.',
      'The magnet catches the ends, middles, centres and corners of what is already drawn, so a new line meets the drawing instead of nearly meeting it.',
      'Holding Shift while drawing keeps a line level, upright or on 45°.',
    ],
    modify: [
      'Click a shape to pick it, shift-click to add another, or drag a box around several.',
      'A picked shape shows handles. Drag a square one and only that end moves, so a line is shortened from the end you took hold of; the diamond in the middle carries the whole shape. Hold Shift to keep it level, upright or on 45°, and the length and angle are shown against the cursor as you go.',
      'With something picked, the Selection panel on the right shows its geometry in millimetres — start, end, length, angle — and every one of them can be typed. That is how a line goes from about right to exactly 111.00 mm.',
      'Turn, mirror, scale, align and spread out are on the modify bar. They all work on whatever is picked.',
      'Trim cuts a line back to whatever crosses it — click the piece you want gone.',
      'Extend runs a line on until it meets something — click the end that should grow.',
      'Corner brings two lines together where they would meet, cutting or extending both. Give it a radius and the corner is rounded instead.',
    ],
    keys: [
      'V select · H pan · L line · P polyline · R rectangle · C circle · E ellipse · A arc · T text · D dimension',
      'X trim · W extend · K corner',
      'F fits the sheet · Space pans while held · the wheel zooms about the cursor',
      'Ctrl+Z undoes · Ctrl+Shift+Z redoes · Ctrl+D duplicates · Ctrl+A picks everything · Del removes',
      'Arrow keys nudge by the snap step, Shift+arrow by ten',
      'Esc backs out one step: what is half-drawn, then the selection, then the tool',
    ],
    tips: [
      'Edits are kept with the project when you press Save — then save the project itself.',
      'Layers can be hidden or locked while you work; a hidden layer stays out of the SVG you export.',
      'A dashed line stays dashed in the DXF: it goes out as a real CAD line type.',
      'Persian and Turkish labels come out right through Print / PDF. The direct PDF button writes Latin text only.',
      'Watch the text height in millimetres on the toolbar — under 1.8 mm a plotted drawing stops being readable.',
    ],
  },
};

const FA: Strings = {
  select: 'انتخاب', pan: 'جابه‌جایی نما — یا نگه‌داشتن Space', line: 'خط',
  polyline: 'چندخطی — با Enter، راست‌کلیک یا دابل‌کلیک تمام می‌شود',
  connect: 'اتصال — دو نقطه، سیم گوشه‌دار روی لایهٔ WIRE، با نقطهٔ اتصال هرجا به سیم موجود بخورد',
  xlsxImport: 'اکسل',
  xlsxImportTip: 'اکسل را به‌صورت جدول روی نقشه و روی لایهٔ TABLE رسم می‌کند',
  xlsxUpdate: 'به‌روزرسانی',
  xlsxUpdateTip: 'همان فایل را دوباره می‌خواند و این جدول را در جای خودش بازرسم می‌کند',
  xlsxEmpty: 'این فایل اکسل سطری برای رسم ندارد.',
  xlsxUnreadable: 'فایل خوانده نشد — باید .xlsx یا .xls یا .csv باشد.',
  xlsxGone: 'فایل دوباره خوانده نشد — شاید جابه‌جا یا تغییر نام داده شده باشد.',
  wireNumber: 'شماره‌گذاری سیم',
  wireNumberTip: 'به هر شبکه یک شماره می‌دهد و روی سیم می‌نویسد. سیم‌هایی که از قبل شماره دارند دست‌نخورده می‌مانند.',
  wireNumbered: '{n} سیم شماره‌گذاری شد.',
  wireAllNumbered: 'همهٔ سیم‌ها از قبل شماره دارند.',
  wireNoneFound: 'سیمی برای شماره‌گذاری در این شیت نیست.',
  tagDevices: 'نام‌گذاری',
  tagDevicesTip: 'به هر سمبل بدون نام، نام استاندارد IEC می‌دهد و از بالاترین شمارهٔ موجود ادامه می‌دهد.',
  tagged: '{n} دستگاه نام‌گذاری شد.',
  tagAllTagged: 'همهٔ دستگاه‌ها از قبل نام دارند.',
  checks: 'بررسی',
  checksTip: 'شیت را بررسی می‌کند: سر سیم آزاد، نام تکراری، تقاطع بدون نقطهٔ اتصال.',
  checksClean: 'در این شیت موردی برای گزارش نیست.',
  xrefs: 'در شیت‌های دیگر',
  xrefOn: 'در',
  colourOfPicked: 'رنگ موارد انتخاب‌شده (فقط SVG و PDF — در CAD رنگ از لایه می‌آید)',
  colourOfNew: 'رنگ چیزی که بعد کشیده می‌شود',
  colourClear: 'بازگشت به رنگ لایه',
  colourClearShort: 'لایه',
  ask: 'برایم بکش',
  askTip: 'مدار را توصیف کنید تا مدل محلی پیش‌نویس آن را روی این شیت بکشد',
  askPlaceholder: 'مثلاً: راه‌انداز موتور — کلید جداکننده، فیوز، کنتاکتور، بی‌متال، موتور، سیم‌کشی از بالا به پایین',
  askNote: 'یک پیش‌نویس برای اصلاح است، نه پاسخ نهایی. در یک مرحلهٔ undo برداشته می‌شود.',
  askGo: 'بکش',
  askWorking: 'در حال کشیدن…',
  askDrew: '{n} شکل کشیده شد.',
  askDrewSome: '{n} شکل کشیده شد — {d} مورد غیرقابل‌استفاده حذف شد، بازبینی کنید.',
  askFailed: 'مدل نتوانست این را بکشد.',
  rect: 'مستطیل', circle: 'دایره — مرکز، سپس شعاع',
  ellipse: 'بیضی — مرکز، سپس دو شعاع',
  arc: 'کمان — مرکز، شروع، سپس مقدار جاروب', text: 'متن',
  dim: 'اندازه‌گذاری — از، تا، سپس محل خط اندازه',
  trim: 'بریدن (Trim) — روی تکه‌ای از خط که باید حذف شود کلیک کنید',
  extend: 'امتداد (Extend) — روی سر خط کلیک کنید تا ادامه یابد',
  corner: 'گوشه (Corner) — روی دو خط کلیک کنید تا به هم برسند',

  zoomIn: 'بزرگ‌نمایی', zoomOut: 'کوچک‌نمایی', fit: 'جا دادن کل صفحه (F)',
  zoomSel: 'بزرگ‌نمایی روی انتخاب',
  undo: 'واگرد (Ctrl+Z)', redo: 'ازنو (Ctrl+Shift+Z)',
  duplicate: 'تکثیر (Ctrl+D)', del: 'حذف (Del)',
  revert: 'بازگرداندن این صفحه به حالت اولیه',

  save: 'ثبت این ویرایش‌ها در پروژه (سپس پروژه را ذخیره کنید)',
  savedAlready: 'این ویرایش‌ها از قبل در پروژه ثبت شده‌اند',
  cannotKeep: 'این ویرایش‌ها در این پروژه قابل ثبت نیستند',
  readOnly: 'این ریویژن فقط‌خواندنی است — برای ثبت ویرایش، ریویژن جدید بسازید',
  discardAll: 'انصراف از همه',
  discardAllTip: 'بازگرداندن همه صفحه‌ها به حالت اولیه، در پروژه هم',

  grid: 'نمایش شبکه', noSnap: 'بدون پرش', snapTo: 'پرش جابه‌جایی و نقاط جدید به این گام',
  osnapOn: 'گرفتن سر و گوشه و مرکز اشیای موجود — برای خاموش‌کردن کلیک کنید',
  osnapOff: 'سر و گوشه اشیای موجود گرفته نمی‌شود',
  fullscreen: 'تمام‌صفحه', leaveFullscreen: 'خروج از تمام‌صفحه (Esc)',
  help: 'راهنمای نقشه‌کشی (F1)', closeHelp: 'بستن',

  modify: 'ویرایش',
  rotateCW: 'چرخش ۹۰ درجه ساعتگرد', rotateCCW: 'چرخش ۹۰ درجه پادساعتگرد',
  rotateFree: 'چرخش با زاویه دلخواه', mirrorH: 'قرینه چپ و راست',
  mirrorV: 'قرینه بالا و پایین', scale: 'تغییر مقیاس',
  alignLeft: 'تراز از چپ', alignRight: 'تراز از راست',
  alignTop: 'تراز از بالا', alignBottom: 'تراز از پایین',
  centreX: 'وسط‌چین افقی', centreY: 'وسط‌چین عمودی',
  spreadX: 'یکسان‌کردن فاصله‌ها به‌صورت افقی', spreadY: 'یکسان‌کردن فاصله‌ها به‌صورت عمودی',
  toFront: 'آوردن به جلو', toBack: 'بردن به عقب',

  layerOf: 'لایه‌ای که ترسیم جدید روی آن می‌رود', widthOf: 'ضخامت خط',
  lineTypeOf: 'نوع خط', textHeightOf: 'ارتفاع متن، به واحد نقشه',
  solid: 'ممتد', dashed: 'خط‌چین', dashDot: 'خط‌نقطه', dotted: 'نقطه‌چین',
  paperOf: 'کاغذی که DXF و PDF روی آن می‌نشیند. «اندازه نقشه» مقیاس را نگه می‌دارد و کاغذ را بزرگ می‌کند.',
  fitDrawing: 'اندازه نقشه',
  header: 'هدر',
  headerTip: 'کادر، شبکهٔ ناحیه‌بندی و جدول عنوان، به‌صورت هندسهٔ واقعی روی شیت: مثل بقیهٔ نقشه رسم و چاپ و خروجی می‌شود و هر خانه‌اش قابل بازنویسی است',
  headerOff: 'روی شیت هست. دوباره بزنید تا کادر، ناحیه‌بندی و جدول عنوان برداشته شود.',
  headerTooSmall: 'این شیت برای کادر گرفتن کوچک است.',
  headerFitted: 'نقشه به {n}٪ کوچک شد تا داخل کادر جا بگیرد. اگر می‌خواهید خودتان جابه‌جا کنید، undo بزنید.',
  tabHome: 'خانه', tabElectrical: 'برق', tabOutput: 'خروجی', tabView: 'نما',
  panDraw: 'رسم', panModify: 'ویرایش', panArrange: 'چیدمان', panProps: 'ویژگی‌ها',
  panBlock: 'بلوک', panAnnotate: 'شماره‌گذاری', panCheck: 'بازبینی', panTable: 'جدول',
  panSheet: 'برگه', panExport: 'خروجی گرفتن', panKeep: 'نگهداری',
  panZoom: 'بزرگ‌نمایی', panAids: 'کمک‌ها', panApp: 'برنامه',

  geometry: 'هندسه', inMm: 'میلی‌متر',
  lengthOf: 'طول', angleOf: 'زاویه', radiusOf: 'شعاع',
  startX: 'X شروع', startY: 'Y شروع', endX: 'X پایان', endY: 'Y پایان',
  centreXOf: 'X مرکز', centreYOf: 'Y مرکز', widthMm: 'عرض', heightMm: 'ارتفاع',
  radiusXOf: 'شعاع X', radiusYOf: 'شعاع Y', sweepFrom: 'از', sweepTo: 'تا',
  atX: 'X', atY: 'Y', rotationOf: 'چرخش',
  pointsN: n => `${n} نقطه`,
  dragGrips: 'دستگیره مربعی را بکشید تا فقط همان سر جابه‌جا شود؛ لوزی کل شکل را می‌برد. با نگه‌داشتن Shift خط افقی یا عمودی یا ۴۵ درجه می‌ماند.',

  group: 'گروه‌کردن در یک بلاک (Ctrl+G)',
  ungroup: 'شکستن بلاک (Ctrl+Shift+G)',
  blocksN: n => `${n} بلاک`,
  inBlock: 'داخل یک بلاک — با انتخاب یک جزء، کل آن انتخاب می‌شود',
  needTwoToGroup: 'برای گروه‌کردن، دو شکل یا بیشتر انتخاب کنید',
  nothingToUngroup: 'چیزی که انتخاب شده در بلاکی نیست',
  openLibrary: 'کتابخانه علائم — یک سیمبل بگذارید، یا از فایل بیاورید',
  libTitle: 'کتابخانه علائم',
  libNote: 'یک سیمبل روی صفحه بگذارید، یا از همین کامپیوتر بیاورید. همه به‌صورت یک بلاک وارد می‌شوند.',
  libSearch: 'جستجوی سیمبل…',
  libNoneFound: 'چیزی با این عبارت پیدا نشد.',
  libFromFile: 'از فایل',
  libFromFileNote: 'یک DXF یا SVG از این کامپیوتر بخوان و بگذار',
  libImport: 'گذاشتن روی صفحه',
  libAsBlock: 'به‌صورت یک بلاک، وسط نما گذاشته می‌شود. آن را به جای خودش بکشید؛ اگر اجزایش را لازم داشتید از نوار ابزار بشکنیدش.',
  libPickOne: 'یک سیمبل را انتخاب کنید تا بزرگ‌تر ببینید و بگذارید. با دابل‌کلیک مستقیم گذاشته می‌شود.',
  libDoubleClick: 'دابل‌کلیک برای گذاشتن',
  libNothingIn: name => `در ${name} هندسه‌ای نیست`,
  libPlaced: name => `${name} به‌صورت بلاک گذاشته شد — آن را به جای خودش بکشید`,

  themeLight: 'روشن', themeDark: 'تیره',

  layers: 'لایه‌ها', selection: 'انتخاب‌شده', typeOf: 'نوع', textOf: 'متن',
  pickedN: n => `${n} شکل`,
  nothingPicked: 'روی چیزی کلیک کنید تا انتخاب شود، یا با کشیدن کادر چند شکل را بگیرید. برای تغییر متن، روی آن دوبار کلیک کنید.',
  showLayer: 'نمایش این لایه', hideLayer: 'پنهان‌کردن این لایه',
  lockLayer: 'قفل‌کردن این لایه', unlockLayer: 'بازکردن قفل این لایه',
  appliesToPicked: 'تغییر هرکدام، روی همان چیزی که انتخاب شده اعمال می‌شود.',

  shapesN: n => `${n} شکل`,
  zoomPct: n => `بزرگ‌نمایی ٪${n}`,
  edited: 'ویرایش‌شده', notKept: 'هنوز ثبت نشده', keptWithProject: 'در پروژه ثبت شد',
  staleN: n => `${n} صفحه روی نقشه قدیمی‌تر ویرایش شده است`,
  nothingToDraw: 'هنوز چیزی برای ترسیم نیست.',

  hintIdle: 'Space جابه‌جا می‌کند · غلتک بزرگ‌نمایی · F جا می‌دهد · Ctrl+Z واگرد · F1 راهنما',
  hintText: 'جایی که متن باید بنشیند کلیک کنید',
  hintPolyline: 'روی هر گوشه کلیک کنید · Backspace یک نقطه عقب می‌رود · Enter یا راست‌کلیک یا دابل‌کلیک تمام می‌کند · Esc لغو',
  hintTwoClicks: 'کلیک کنید، بعد دوباره کلیک کنید · Shift خط را صاف نگه می‌دارد · راست‌کلیک یا Esc لغو',
  hintDim: 'اول مبدأ اندازه، بعد مقصد، بعد جای خط اندازه را کلیک کنید',
  hintTrim: 'روی تکه‌ای از خط که باید برود کلیک کنید — تا محل تقاطع بریده می‌شود',
  hintExtend: 'روی سر خط کلیک کنید تا تا اولین مانع پیش برود',
  hintCornerFirst: 'روی خط اول، در سمتی که باید بماند، کلیک کنید',
  hintCornerSecond: 'حالا روی خط دوم، در سمتی که باید بماند',

  needALine: 'این فرمان روی خط مستقیم کار می‌کند',
  noCrossing: 'چیزی سر راه نیست که خط به آن برسد',
  areParallel: 'این دو موازی‌اند — گوشه‌ای ندارند',

  promptText: 'متن', promptRotate: 'چند درجه بچرخد؟',
  promptScale: 'با چه ضریبی مقیاس شود؟', promptRadius: 'شعاع گوشه، به واحد نقشه (۰ یعنی گوشه تیز)',
  cornerRadius: 'شعاع گوشه',

  helpTitle: 'نقشه‌کشی با Simorgh Draw',
  helpIntro: 'صفحه نقشه، هندسه است نه عکس — هر چیزی روی آن انتخاب و جابه‌جا و ویرایش و بریده می‌شود، و DXF و PDF و SVG همگی از همان چیزی گرفته می‌شوند که می‌بینید.',
  helpDrawing: 'ترسیم', helpModify: 'تغییر آنچه هست',
  helpKeys: 'کلیدها', helpTips: 'دانستنش خوب است',
  helpFullGuide: 'باز کردن راهنمای کامل',
  helpLines: {
    draw: [
      'ابزار را انتخاب کنید، روی نقطه شروع کلیک کنید و روی نقطه پایان دوباره کلیک کنید. کشیدن هم کار می‌کند — فشار، حرکت، رها.',
      'چندخطی هر تعداد کلیک را می‌گیرد. Backspace آخرین نقطه را برمی‌گرداند، Enter یا راست‌کلیک یا دابل‌کلیک تمامش می‌کند، Esc رهایش می‌کند.',
      'کمان سه کلیک است: مرکز، محل شروع، سپس مقدار جاروب.',
      'اندازه‌گذاری سه کلیک است: از کجا، تا کجا، سپس جای خط اندازه. عدد به میلی‌متر نوشته می‌شود.',
      'آهن‌ربا سر و وسط و مرکز و گوشه اشیای موجود را می‌گیرد تا خط جدید واقعاً به نقشه برسد، نه اینکه نزدیکش بایستد.',
      'نگه‌داشتن Shift هنگام ترسیم، خط را افقی یا عمودی یا ۴۵ درجه نگه می‌دارد.',
    ],
    modify: [
      'برای انتخاب روی شکل کلیک کنید، با Shift شکل دیگری اضافه کنید، یا کادری دور چند شکل بکشید.',
      'شکل انتخاب‌شده دستگیره نشان می‌دهد. دستگیره مربعی را بکشید تا فقط همان سر جابه‌جا شود — یعنی خط از همان سمتی که گرفته‌اید کوتاه می‌شود؛ لوزی وسط، کل شکل را می‌برد. با Shift خط افقی یا عمودی یا ۴۵ درجه می‌ماند و طول و زاویه هم کنار مکان‌نما نشان داده می‌شود.',
      'با انتخاب یک شکل، پنل «انتخاب‌شده» در سمت راست هندسه آن را به میلی‌متر نشان می‌دهد — شروع، پایان، طول، زاویه — و همه را می‌شود تایپ کرد. این‌طور یک خط از «تقریباً درست» به دقیقاً ۱۱۱٫۰۰ میلی‌متر می‌رسد.',
      'چرخش، قرینه، مقیاس، تراز و یکسان‌کردن فاصله‌ها روی نوار ویرایش هستند و همه روی چیزی که انتخاب شده کار می‌کنند.',
      'Trim خط را تا محل تقاطعش می‌برد — روی تکه‌ای که باید برود کلیک کنید.',
      'Extend خط را تا اولین مانع پیش می‌برد — روی سری که باید رشد کند کلیک کنید.',
      'Corner دو خط را به محل تلاقی می‌رساند و هر دو را می‌برد یا امتداد می‌دهد. اگر شعاع بدهید، گوشه گرد می‌شود.',
    ],
    keys: [
      'V انتخاب · H جابه‌جایی · L خط · P چندخطی · R مستطیل · C دایره · E بیضی · A کمان · T متن · D اندازه',
      'X بریدن · W امتداد · K گوشه',
      'F کل صفحه را جا می‌دهد · Space تا وقتی نگه دارید جابه‌جا می‌کند · غلتک حول مکان‌نما بزرگ‌نمایی می‌کند',
      'Ctrl+Z واگرد · Ctrl+Shift+Z ازنو · Ctrl+D تکثیر · Ctrl+A انتخاب همه · Del حذف',
      'کلیدهای جهت به اندازه گام پرش جابه‌جا می‌کنند، Shift+جهت ده برابر',
      'Esc یک پله عقب می‌رود: اول ترسیم نیمه‌کاره، بعد انتخاب، بعد ابزار',
    ],
    tips: [
      'ویرایش‌ها با زدن Save در پروژه ثبت می‌شوند — بعد خود پروژه را ذخیره کنید.',
      'لایه‌ها را می‌شود هنگام کار پنهان یا قفل کرد؛ لایه پنهان در خروجی SVG هم نمی‌آید.',
      'خط‌چین در DXF هم خط‌چین می‌ماند: به‌صورت نوع خط واقعی CAD بیرون می‌رود.',
      'متن فارسی و ترکی از مسیر Print / PDF درست درمی‌آید. دکمه مستقیم PDF فقط حروف لاتین را می‌نویسد.',
      'ارتفاع متن به میلی‌متر را روی نوار ابزار ببینید — زیر ۱٫۸ میلی‌متر، نقشه چاپ‌شده خوانا نیست.',
    ],
  },
};

const TR: Strings = {
  select: 'Seç', pan: 'Kaydır — ya da Space tuşunu basılı tutun', line: 'Çizgi',
  polyline: 'Çoklu çizgi — Enter, sağ tık veya çift tık bitirir',
  connect: 'Bağlantı — iki nokta, WIRE katmanında dik kablo, mevcut hatta değdiği yere nokta',
  xlsxImport: 'Excel',
  xlsxImportTip: 'Tabloyu TABLE katmanında çizim üzerine tablo olarak çizer',
  xlsxUpdate: 'Güncelle',
  xlsxUpdateTip: 'Aynı dosyayı yeniden okur ve bu tabloyu yerinde yeniden çizer',
  xlsxEmpty: 'Bu tabloda çizilecek satır yok.',
  xlsxUnreadable: 'Dosya okunamadı — .xlsx, .xls veya .csv olmalı.',
  xlsxGone: 'Dosya yeniden okunamadı — taşınmış veya adı değişmiş olabilir.',
  wireNumber: 'Kablo numarala',
  wireNumberTip: 'Her şebekeye numara verir ve kabloya yazar. Zaten numaralı olanlara dokunulmaz.',
  wireNumbered: '{n} kablo numaralandı.',
  wireAllNumbered: 'Tüm kablolar zaten numaralı.',
  wireNoneFound: 'Bu sayfada numaralanacak kablo yok.',
  tagDevices: 'Etiketle',
  tagDevicesTip: 'Etiketsiz her sembole IEC etiketi verir, kullanılan en yüksek numaradan devam eder.',
  tagged: '{n} cihaz etiketlendi.',
  tagAllTagged: 'Tüm cihazlar zaten etiketli.',
  checks: 'Kontroller',
  checksTip: 'Sayfayı gözden geçirir: açık kablo uçları, tekrarlanan etiketler, noktasız kesişmeler.',
  checksClean: 'Bu sayfada bildirilecek bir şey yok.',
  xrefs: 'Diğer sayfalarda',
  xrefOn: 'sayfa',
  colourOfPicked: 'Seçilenlerin rengi (yalnızca SVG ve PDF — CAD rengi katmandan alır)',
  colourOfNew: 'Sonra çizilecek olanın rengi',
  colourClear: 'Katman rengine dön',
  colourClearShort: 'Katman',
  ask: 'Benim için çiz',
  askTip: 'Bir devre tarif edin, yerel model bu sayfaya taslağını çizsin',
  askPlaceholder: 'örn. motor yol vericisi: şalter, sigorta, kontaktör, termik, motor — yukarıdan aşağıya',
  askNote: 'Düzeltilecek bir taslak, kesin cevap değil. Tek geri alma adımıyla kaldırılır.',
  askGo: 'Çiz',
  askWorking: 'Çiziliyor…',
  askDrew: '{n} şekil çizildi.',
  askDrewSome: '{n} şekil çizildi — {d} tanesi kullanılamaz olduğu için atıldı, gözden geçirin.',
  askFailed: 'Model bunu çizemedi.',
  rect: 'Dikdörtgen', circle: 'Daire — merkez, sonra yarıçap',
  ellipse: 'Elips — merkez, sonra iki yarıçap',
  arc: 'Yay — merkez, başlangıç, sonra süpürme', text: 'Yazı',
  dim: 'Ölçü — nereden, nereye, sonra ölçü çizgisinin yeri',
  trim: 'Buda (Trim) — çizginin atılacak parçasına tıklayın',
  extend: 'Uzat (Extend) — çizginin uzayacak ucuna tıklayın',
  corner: 'Köşe (Corner) — iki çizgiye tıklayın, birleşsinler',

  zoomIn: 'Yakınlaştır', zoomOut: 'Uzaklaştır', fit: 'Sayfayı sığdır (F)',
  zoomSel: 'Seçime yakınlaş',
  undo: 'Geri al (Ctrl+Z)', redo: 'Yinele (Ctrl+Shift+Z)',
  duplicate: 'Çoğalt (Ctrl+D)', del: 'Sil (Del)',
  revert: 'Bu sayfayı çizildiği hâline döndür',

  save: 'Bu değişiklikleri projeye işle (sonra projeyi kaydedin)',
  savedAlready: 'Proje bu değişiklikleri zaten tutuyor',
  cannotKeep: 'Bu değişiklikler bu projeye işlenemez',
  readOnly: 'Bu revizyon salt okunur — değişiklik işlemek için yeni revizyon açın',
  discardAll: 'Hepsini geri al',
  discardAllTip: 'Bütün sayfaları çizildikleri hâle döndür, projede de',

  grid: 'Izgarayı göster', noSnap: 'kenetlenme yok',
  snapTo: 'Taşımaları ve yeni noktaları bu adıma kenetle',
  osnapOn: 'Çizilmiş nesnelerin uç ve köşelerini yakalıyor — durdurmak için tıklayın',
  osnapOff: 'Çizilmiş nesnelerin uç ve köşeleri yakalanmıyor',
  fullscreen: 'Tam ekran', leaveFullscreen: 'Tam ekrandan çık (Esc)',
  help: 'Bununla nasıl çizilir (F1)', closeHelp: 'Kapat',

  modify: 'Değiştir',
  rotateCW: '90° saat yönünde döndür', rotateCCW: '90° saat yönünün tersine döndür',
  rotateFree: 'Açı vererek döndür', mirrorH: 'Sağa sola aynala',
  mirrorV: 'Yukarı aşağı aynala', scale: 'Ölçekle',
  alignLeft: 'Sola hizala', alignRight: 'Sağa hizala',
  alignTop: 'Üste hizala', alignBottom: 'Alta hizala',
  centreX: 'Yatayda ortala', centreY: 'Dikeyde ortala',
  spreadX: 'Yatay aralıkları eşitle', spreadY: 'Dikey aralıkları eşitle',
  toFront: 'Öne getir', toBack: 'Arkaya gönder',

  layerOf: 'Yeni çizimin gideceği katman', widthOf: 'Çizgi kalınlığı',
  lineTypeOf: 'Çizgi tipi', textHeightOf: 'Yazı yüksekliği, çizim biriminde',
  solid: 'sürekli', dashed: 'kesikli', dashDot: 'çizgi-nokta', dotted: 'noktalı',
  paperOf: "DXF ve PDF'in oturacağı kâğıt. 'Çizime sığdır' ölçeği korur, kâğıdı büyütür.",
  fitDrawing: 'çizime sığdır',
  header: 'Başlık',
  headerTip: 'Çerçeve, bölge ızgarası ve başlık kartuşu, sayfaya gerçek geometri olarak: gerisi gibi çizilir, basılır, dışa aktarılır ve her hücresi yeniden yazılabilir',
  headerOff: 'Sayfada. Çerçeveyi, bölge ızgarasını ve kartuşu kaldırmak için tekrar basın.',
  headerTooSmall: 'Bu sayfa bir çerçeve taşıyacak kadar büyük değil.',
  headerFitted: 'Çizim, çerçevenin içine sığması için %{n} oranına küçültüldü. Kendiniz taşımak isterseniz geri alın.',
  tabHome: 'Giriş', tabElectrical: 'Elektrik', tabOutput: 'Çıktı', tabView: 'Görünüm',
  panDraw: 'Çiz', panModify: 'Değiştir', panArrange: 'Diz', panProps: 'Özellikler',
  panBlock: 'Blok', panAnnotate: 'Etiketle', panCheck: 'Denetle', panTable: 'Tablo',
  panSheet: 'Sayfa', panExport: 'Dışa aktar', panKeep: 'Sakla',
  panZoom: 'Yakınlaştır', panAids: 'Yardımcılar', panApp: 'Uygulama',

  geometry: 'Geometri', inMm: 'milimetre',
  lengthOf: 'Uzunluk', angleOf: 'Açı', radiusOf: 'Yarıçap',
  startX: 'Başlangıç X', startY: 'Başlangıç Y', endX: 'Bitiş X', endY: 'Bitiş Y',
  centreXOf: 'Merkez X', centreYOf: 'Merkez Y', widthMm: 'Genişlik', heightMm: 'Yükseklik',
  radiusXOf: 'Yarıçap X', radiusYOf: 'Yarıçap Y', sweepFrom: 'Başlangıç', sweepTo: 'Bitiş',
  atX: 'X', atY: 'Y', rotationOf: 'Dönüş',
  pointsN: n => `${n} nokta`,
  dragGrips: 'Kare tutamağı sürükleyin, yalnızca o uç gitsin; baklava tutamak nesnenin tamamını taşır. Shift basılıyken yatay, dikey ya da 45° kalır.',

  group: 'Blok hâline getir (Ctrl+G)',
  ungroup: 'Bloğu parçala (Ctrl+Shift+G)',
  blocksN: n => `${n} blok`,
  inBlock: 'Bir blokta — bir parçasını seçmek tamamını seçer',
  needTwoToGroup: 'Gruplamak için iki ya da daha fazla nesne seçin',
  nothingToUngroup: 'Seçili olanların hiçbiri blokta değil',
  openLibrary: 'Sembol kitaplığı — bir sembol yerleştirin ya da dosyadan getirin',
  libTitle: 'Sembol kitaplığı',
  libNote: 'Sayfaya bir sembol yerleştirin ya da bu bilgisayardan getirin. Hepsi tek blok olarak gelir.',
  libSearch: 'Sembol ara…',
  libNoneFound: 'Buna uyan bir şey yok.',
  libFromFile: 'Dosyadan',
  libFromFileNote: 'Bu bilgisayardan bir DXF ya da SVG okuyup yerleştir',
  libImport: 'Sayfaya yerleştir',
  libAsBlock: 'Görünümün ortasına tek blok olarak gelir. Yerine sürükleyin; parçaları lazımsa araç çubuğundan parçalayın.',
  libPickOne: 'Büyük görmek ve yerleştirmek için bir sembol seçin. Çift tıklarsanız doğrudan yerleşir.',
  libDoubleClick: 'yerleştirmek için çift tık',
  libNothingIn: name => `${name} içinde geometri yok`,
  libPlaced: name => `${name} blok olarak yerleşti — yerine sürükleyin`,

  themeLight: 'Açık', themeDark: 'Koyu',

  layers: 'Katmanlar', selection: 'Seçim', typeOf: 'Tür', textOf: 'Yazı',
  pickedN: n => `${n} nesne`,
  nothingPicked: 'Seçmek için bir nesneye tıklayın ya da birkaçının etrafına kutu çizin. Yazıyı değiştirmek için üstüne çift tıklayın.',
  showLayer: 'Bu katmanı göster', hideLayer: 'Bu katmanı gizle',
  lockLayer: 'Bu katmanı kilitle', unlockLayer: 'Bu katmanın kilidini aç',
  appliesToPicked: 'Bunlardan birini değiştirmek, seçili olanı yeniden çizer.',

  shapesN: n => `${n} nesne`,
  zoomPct: n => `yakınlık %${n}`,
  edited: 'değişti', notKept: 'henüz işlenmedi', keptWithProject: 'projeye işlendi',
  staleN: n => `${n} sayfa daha eski bir çizim üzerinde değiştirilmiş`,
  nothingToDraw: 'Henüz çizilecek bir şey yok.',

  hintIdle: 'Space kaydırır · tekerlek yakınlaştırır · F sığdırır · Ctrl+Z geri alır · F1 yardım',
  hintText: 'Yazının geleceği yere tıklayın',
  hintPolyline: 'Her köşeye tıklayın · Backspace bir nokta geri alır · Enter, sağ tık veya çift tık bitirir · Esc iptal',
  hintTwoClicks: 'Tıklayın, sonra tekrar tıklayın · Shift çizgiyi düzler · sağ tık veya Esc iptal',
  hintDim: 'Önce nereden, sonra nereye, sonra ölçü çizgisinin yerine tıklayın',
  hintTrim: 'Çizginin atılacak parçasına tıklayın — kesiştiği yere kadar budanır',
  hintExtend: 'Çizginin ucuna tıklayın, önündeki ilk nesneye kadar uzasın',
  hintCornerFirst: 'İlk çizgiye, kalmasını istediğiniz taraftan tıklayın',
  hintCornerSecond: 'Şimdi ikinci çizgiye, kalmasını istediğiniz taraftan',

  needALine: 'Bu komut düz çizgilerde çalışır',
  noCrossing: 'Uzayacağı bir şey önünde yok',
  areParallel: 'Bu ikisi paralel — köşeleri olmaz',

  promptText: 'Yazı', promptRotate: 'Kaç derece dönsün?',
  promptScale: 'Hangi katsayıyla ölçeklensin?',
  promptRadius: 'Köşe yarıçapı, çizim biriminde (keskin köşe için 0)',
  cornerRadius: 'Köşe yarıçapı',

  helpTitle: 'Simorgh Draw ile çizim',
  helpIntro: 'Sayfa bir resim değil, geometridir — üzerindeki her şey seçilebilir, taşınabilir, biçimi değiştirilebilir ve budanabilir; DXF, PDF ve SVG hep gördüğünüzden üretilir.',
  helpDrawing: 'Çizmek', helpModify: 'Var olanı değiştirmek',
  helpKeys: 'Tuşlar', helpTips: 'Bilmekte fayda var',
  helpFullGuide: 'Tam kılavuzu aç',
  helpLines: {
    draw: [
      'Bir araç seçin, şeklin başladığı yere tıklayın, bittiği yere tekrar tıklayın. Sürüklemek de olur — bas, gez, bırak.',
      'Çoklu çizgi istediğiniz kadar tıklama alır. Backspace son noktayı geri alır; Enter, sağ tık ya da çift tık bitirir; Esc atar.',
      'Yay üç tıklamadır: merkez, başladığı yer, sonra ne kadar süpüreceği.',
      'Ölçü üç tıklamadır: nereden, nereye, sonra ölçü çizgisinin yeri. Değer milimetre yazılır.',
      'Mıknatıs çizilmiş nesnelerin uçlarını, ortalarını, merkezlerini ve köşelerini yakalar; yeni çizgi çizime gerçekten değer, yaklaşmakla kalmaz.',
      'Çizerken Shift basılıysa çizgi yatay, dikey ya da 45° kalır.',
    ],
    modify: [
      'Seçmek için nesneye tıklayın, Shift ile bir tane daha ekleyin ya da birkaçının etrafına kutu çizin.',
      'Seçili nesne tutamaklarını gösterir. Kare tutamağı sürükleyin, yalnızca o uç gitsin — yani çizgi tuttuğunuz uçtan kısalır; ortadaki baklava tutamak nesnenin tamamını taşır. Shift basılıyken yatay, dikey ya da 45° kalır; uzunluk ve açı imlecin yanında yazar.',
      'Bir nesne seçiliyken sağdaki Seçim paneli geometriyi milimetre olarak gösterir — başlangıç, bitiş, uzunluk, açı — ve hepsi yazılabilir. Bir çizgi “yaklaşık”tan tam 111,00 mm’ye böyle gider.',
      'Döndürme, aynalama, ölçekleme, hizalama ve aralık eşitleme değiştirme çubuğundadır; hepsi seçili olan üzerinde çalışır.',
      'Trim çizgiyi kesiştiği yere kadar budar — gitmesini istediğiniz parçaya tıklayın.',
      'Extend çizgiyi önündeki ilk nesneye kadar uzatır — uzayacak uca tıklayın.',
      'Corner iki çizgiyi buluşacakları yerde birleştirir, gerekirse ikisini de budar ya da uzatır. Yarıçap verirseniz köşe yuvarlanır.',
    ],
    keys: [
      'V seç · H kaydır · L çizgi · P çoklu çizgi · R dikdörtgen · C daire · E elips · A yay · T yazı · D ölçü',
      'X buda · W uzat · K köşe',
      'F sayfayı sığdırır · Space basılıyken kaydırır · tekerlek imlecin çevresinde yakınlaştırır',
      'Ctrl+Z geri alır · Ctrl+Shift+Z yineler · Ctrl+D çoğaltır · Ctrl+A hepsini seçer · Del siler',
      'Yön tuşları kenetlenme adımı kadar iter, Shift+yön on katı',
      'Esc bir adım geri çıkar: önce yarım çizim, sonra seçim, sonra araç',
    ],
    tips: [
      'Değişiklikler Save ile projeye işlenir — sonra projenin kendisini kaydedin.',
      'Katmanlar çalışırken gizlenebilir ya da kilitlenebilir; gizli katman dışa aktarılan SVG’ye de girmez.',
      'Kesikli çizgi DXF’te de kesikli kalır: gerçek bir CAD çizgi tipi olarak çıkar.',
      'Farsça ve Türkçe yazılar Print / PDF yolundan düzgün çıkar. Doğrudan PDF düğmesi yalnızca Latin harf yazar.',
      'Araç çubuğundaki milimetre cinsinden yazı yüksekliğine bakın — 1,8 mm altında basılmış çizim okunmaz olur.',
    ],
  },
};

export const STRINGS: Record<Lang, Strings> = { en: EN, fa: FA, tr: TR };

const KEY = 'simorgh-draw-lang';

/** The language last chosen here, or English. */
export function loadLang(): Lang {
  try {
    const kept = window.localStorage.getItem(KEY);
    if (kept === 'en' || kept === 'fa' || kept === 'tr') return kept;
  } catch { /* a browser that will not keep anything is not an error */ }
  return 'en';
}

export function saveLang(l: Lang): void {
  try { window.localStorage.setItem(KEY, l); } catch { /* nothing to do */ }
}
