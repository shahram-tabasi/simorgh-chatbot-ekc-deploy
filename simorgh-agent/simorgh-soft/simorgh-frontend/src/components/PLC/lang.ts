// src/components/PLC/lang.ts
//
// The PLC page in English and Persian.
//
// The office that writes these programs works in Persian; the software the
// program is finally typed into is in English. So the page turns and the
// **vocabulary does not**: `TON` is TON, `%I0.0` is `%I0.0`, and `Bool` is
// Bool, in either language. An engineer who has the description in their own
// words and the name in the software's is helped twice; one who has both
// translated cannot find either.
//
// That line is drawn deliberately and it is where every other tool for this
// work draws it. What turns: headings, buttons, messages, the checker's
// findings, the descriptions in the instruction tree. What does not: block
// kinds (OB, FB, FC, DB), data types, addresses, instruction names, SCL
// keywords.
//
// The toolbar keeps its left-to-right order in Persian, like the drawing
// editor's and for the same reason — a row of pictures is not a sentence, and
// every package a controls engineer here has used runs it the same way round.
// Only running text turns, which is what `dirOf` is for.
//
// A key missing from either language is a type error. That is the whole point
// of `Strings` being an interface rather than a bag: a phrase added in English
// and forgotten in Persian would otherwise ship as a blank.

export type Lang = 'en' | 'fa';

export const LANGS: { id: Lang; label: string; dir: 'ltr' | 'rtl' }[] = [
  { id: 'en', label: 'EN', dir: 'ltr' },
  { id: 'fa', label: 'فا', dir: 'rtl' },
];

export const dirOf = (l: Lang): 'ltr' | 'rtl' => (l === 'fa' ? 'rtl' : 'ltr');

export interface Strings {
  /**
   * Which language this bag is.
   *
   * For the handful of places that hold a `Strings` and still have to ask —
   * the instruction help, which lives in the catalogue rather than here, and
   * Monaco's providers, which are registered once for the page and are handed
   * a model rather than a prop.
   */
  lang: Lang;

  // ── The page ──
  pageTitle: string;
  startTitle: string; startWhat: string; startButton: string; startNote: string;
  startReadOnly: string;

  // ── Toolbar ──
  check: string; checkTip: string;
  exportScl: string; exportSclTip: string;
  exportTags: string; exportTagsTip: string;
  find: string; replace: string; format: string; commands: string;
  instructions: string; assistant: string;
  hideCatalogue: string; hideAssistant: string;
  showTree: string; hideTree: string;
  fullscreen: string; leaveFullscreen: string;
  deviceName: string; deviceCpu: string;
  language: string;

  // ── The tree ──
  searchProject: string;
  programBlocks: string; plcTags: string; plcDataTypes: string;
  addNewBlock: string; addNewDataType: string; showAllTags: string;
  obFolder: string; fbFolder: string; fcFolder: string; dbFolder: string; udtFolder: string;
  rename: string; renameTip: string; duplicate: string; exportBlock: string; del: string;
  renameAsk: string; renameBadName: string; renameTaken: string;
  deleteAsk: string; deleteCannotUndo: string;
  deleteInstances: string; deleteCallers: string;

  // ── The block ──
  hideInterface: string; showInterface: string;
  blockComment: string; languageOf: string;
  changeLanguageAsk: string;
  pickABlock: string;
  dbIsValues: string; udtIsStruct: string;
  instanceOf: string; instanceEditThere: string;

  // ── The declaration grid ──
  colName: string; colType: string; colDefault: string; colRetain: string;
  colVisible: string; colWritable: string; colComment: string; colAddress: string;
  addTo: string; insertRowBelow: string; moveUp: string; moveDown: string; deleteRow: string;
  nothingDeclaredFb: string; nothingDeclaredOb: string;
  nothingDeclaredDb: string; nothingDeclaredUdt: string;
  namePlaceholder: string; commentPlaceholder: string;
  retainTip: string; retainOnlyStatic: string; visibleTip: string; writableTip: string;

  // ── Sections ──
  secInput: string; secOutput: string; secInOut: string; secStatic: string;
  secTemp: string; secConstant: string; secReturn: string;
  secInputNote: string; secOutputNote: string; secInOutNote: string; secStaticNote: string;
  secTempNote: string; secConstantNote: string; secReturnNote: string;

  // ── Tags ──
  tagTable: string; addTag: string; addTagNote: string; anotherTable: string;
  filter: string; sortByAddress: string; deleteTable: string;
  tableNameAsk: string; defaultTableKept: string; deleteTableAsk: string;
  noTags: string; noTagMatches: string;
  tagNamePlaceholder: string; tagCommentPlaceholder: string;

  // ── The ladder ──
  network: string; networkTitlePlaceholder: string; networkCommentPlaceholder: string;
  addNetwork: string; addNetworkAfter: string; duplicateNetwork: string;
  deleteNetwork: string; deleteNetworkAsk: string;
  networkOff: string; networkOn: string;
  noNetworks: string; addFirstNetwork: string; addCoil: string;
  openBranch: string; openBranchNote: string; openBranchHere: string;
  closeBranch: string; closeBranchNote: string;
  deleteElement: string; deleteBranch: string; deleteCoil: string;
  copyElement: string; cutElement: string; pasteElement: string; editKeysHint: string;
  contactNo: string; contactNc: string; coil: string; emptyBox: string;
  clickThenPlace: string; putItBack: string; placeHere: string; clickThenPick: string;
  instancePlaceholder: string; instanceTip: string; boxTypeTip: string;
  coilKindAssign: string; coilKindSet: string; coilKindReset: string;
  coilKindP: string; coilKindN: string;

  // ── The catalogue ──
  searchInstructions: string; favorites: string; favoritesEmpty: string;
  matches: string; noMatches: string;
  addFavorite: string; removeFavorite: string; whatItDoes: string;
  needsInstance: string; drawnOnly: string; editorCommand: string;

  // ── Problems and output ──
  problems: string; output: string; nothingWrong: string; pressCheck: string;
  closeStrip: string; show: string; errors: string; warnings: string; notes: string;
  blocksCount: string; readOnlyRevision: string;
  checkRunAt: string; checkSummaryClean: string; checkSummaryBad: string; checkCaveat: string;

  // ── The assistant ──
  assistantTitle: string; copyContext: string; copyContextTip: string; copyContextDone: string;
  askPlaceholder: string; ask: string; working: string;
  starterMotor: string; starterExplain: string; starterFix: string;
  onlyThisBlock: string; wholeProgram: string; noBlockOpen: string;
  sendCatalogue: string; sendCatalogueNote: string; explainMore: string;
  questionsIntro: string; answerAndGo: string; startAgain: string;
  newBlocks: string; replacedBlocks: string; replacedNote: string;
  newTags: string; changedTags: string; changedTagsNote: string;
  afterApply: string; couldNotUse: string; readBefore: string;
  addTheseTags: string; putInProject: string; throwAway: string;
  whatItSaid: string; assistantCaveat: string;

  // ── The new block dialog ──
  newBlockTitle: string; whatKind: string; whatCalls: string; whatFor: string;
  globalDb: string; globalDbNote: string; instanceDb: string; instanceDbNote: string;
  noFbYet: string; whichFb: string;
  writtenIn: string; name: string; number: string; comment: string;
  addBlock: string; cancel: string;
  giveItAName: string; nameRules: string; nameAlreadyUsed: string;
  instanceNeedsFb: string; numberTaken: string;

  // ── Block kinds ──
  kindOb: string; kindFb: string; kindFc: string; kindDb: string; kindUdt: string;
  kindObNote: string; kindFbNote: string; kindFcNote: string;
  kindDbNote: string; kindUdtNote: string;
}

const EN: Strings = {
  lang: 'en',

  pageTitle: 'PLC',
  startTitle: 'No controller in this project yet',
  startWhat: 'This page holds the PLC program for the panel: the organisation, function and '
    + 'data blocks, the tag table that names the wiring, and the instruction catalogue to write '
    + 'them with. It is kept with the project, so the logic and the drawings travel together and '
    + 'the backup carries both.',
  startButton: 'Start a controller',
  startNote: 'It starts as an S7-1500 with OB1 and three tags. The CPU, the tags and everything '
    + 'else can be changed afterwards.',
  startReadOnly: 'This revision is read-only. Open an editable revision to start one.',

  check: 'Check',
  checkTip: 'Read the whole program and list what is wrong with it',
  exportScl: 'Export SCL',
  exportSclTip: 'The whole program as an external source file',
  exportTags: 'Tags CSV',
  exportTagsTip: 'The tag table, as the CSV Siemens reads',
  find: 'Find (Ctrl+F)',
  replace: 'Find and replace (Ctrl+H)',
  format: 'Re-indent the block (Shift+Alt+F)',
  commands: 'Command palette (F1)',
  instructions: 'Instructions',
  assistant: 'Assistant',
  hideCatalogue: 'Put the catalogue away',
  hideAssistant: 'Put the assistant away',
  showTree: 'Bring the project tree back',
  hideTree: 'Put the project tree away',
  fullscreen: 'Full screen',
  leaveFullscreen: 'Leave full screen',
  deviceName: 'What this controller is called in the project',
  deviceCpu: "The CPU — free text, because the catalogue is the customer's",
  language: 'Language',

  searchProject: 'Search in project',
  programBlocks: 'Program blocks',
  plcTags: 'PLC tags',
  plcDataTypes: 'PLC data types',
  addNewBlock: 'Add new block',
  addNewDataType: 'Add new data type',
  showAllTags: 'Show all tags',
  obFolder: 'Organization blocks',
  fbFolder: 'Function blocks',
  fcFolder: 'Functions',
  dbFolder: 'Data blocks',
  udtFolder: 'PLC data types',
  rename: 'Rename…',
  renameTip: 'Every call of it is renamed too',
  duplicate: 'Duplicate',
  exportBlock: 'Export as SCL source',
  del: 'Delete',
  renameAsk: 'What should this block be called?',
  renameBadName: 'A block name is letters, digits and underscores, starting with a letter.',
  renameTaken: 'Something in this project is already called that.',
  deleteAsk: 'Delete',
  deleteCannotUndo: 'This cannot be undone from here.',
  deleteInstances: 'instance data block(s) would be the memory of nothing:',
  deleteCallers: 'block(s) call it by name and would stop compiling:',

  hideInterface: 'Hide interface',
  showInterface: 'Show interface',
  blockComment: 'What this block is for',
  languageOf: 'What the body is written in. Changing it does not translate what is there.',
  changeLanguageAsk: 'is a drawn language and the other is written. What is in the block now '
    + 'cannot be carried across — it will be kept but not shown. Change it?',
  pickABlock: 'Pick a block on the left, or add one.',
  dbIsValues: 'A data block is values and no code. The rows above are the block.',
  udtIsStruct: 'A PLC data type is a structure and no code. The rows above are the type.',
  instanceOf: 'This is the instance data block of',
  instanceEditThere: ". Its rows are that function block's interface — change them there, and "
    + 'they change here. A copy edited in two places is a copy that disagrees with itself.',

  colName: 'Name',
  colType: 'Data type',
  colDefault: 'Default value',
  colRetain: 'Retain',
  colVisible: 'Visible',
  colWritable: 'Writable',
  colComment: 'Comment',
  colAddress: 'Address',
  addTo: 'Add to',
  insertRowBelow: 'Insert row below',
  moveUp: 'Move up',
  moveDown: 'Move down',
  deleteRow: 'Delete row',
  nothingDeclaredFb: 'Nothing declared yet. A block that takes its inputs as parameters can be '
    + 'used for every motor on the panel; the same logic written against global tags can be used '
    + 'once.',
  nothingDeclaredOb: 'Nothing declared yet. An OB is called by the controller, so what it is '
    + 'handed is fixed; Temp and Constant are yours.',
  nothingDeclaredDb: 'No values yet. A data block is its rows — add what the program has to keep.',
  nothingDeclaredUdt: 'No members yet. A PLC data type is declared once here and used as a type '
    + 'wherever that shape is needed, so changing it changes every one of them.',
  namePlaceholder: 'name',
  commentPlaceholder: 'what it is for',
  retainTip: 'Kept through a power cycle',
  retainOnlyStatic: 'Only Static survives a power cycle',
  visibleTip: 'Reachable from the HMI and from OPC UA',
  writableTip: 'Writable from the HMI',

  secInput: 'Input',
  secOutput: 'Output',
  secInOut: 'InOut',
  secStatic: 'Static',
  secTemp: 'Temp',
  secConstant: 'Constant',
  secReturn: 'Return',
  secInputNote: 'Given by the caller; read-only in here',
  secOutputNote: 'Written in here; read by the caller',
  secInOutNote: 'Handed in by reference — written here, seen by the caller',
  secStaticNote: 'Survives the call. FB and DB only — this is the memory',
  secTempNote: 'One call only, and starts as rubbish. Never assume zero',
  secConstantNote: 'A name for a fixed value',
  secReturnNote: 'The one value a function gives back',

  tagTable: 'Tag table',
  addTag: 'Add tag',
  addTagNote: 'The address of the last input tag is carried on, so a row of terminals is entered '
    + 'by typing names.',
  anotherTable: "Another tag table — for grouping a panel's own tags",
  filter: 'Filter…',
  sortByAddress: 'Sort by address — the order the terminals are in',
  deleteTable: 'Delete this table',
  tableNameAsk: 'What is this table called?',
  defaultTableKept: 'The default table is where new tags land — it cannot be removed.',
  deleteTableAsk: 'holds this many tags. Delete it and them?',
  noTags: 'No tags yet. Name the terminals before writing the program against them — it is the '
    + 'difference between a program that can be read and one that cannot.',
  noTagMatches: 'No tag in this table matches that.',
  tagNamePlaceholder: 'Start_PB',
  tagCommentPlaceholder: 'what the wire is for',

  network: 'Network',
  networkTitlePlaceholder: 'what this network is for',
  networkCommentPlaceholder: 'Comment — why it is built this way',
  addNetwork: 'Add network',
  addNetworkAfter: 'Insert network after',
  duplicateNetwork: 'Duplicate network',
  deleteNetwork: 'Delete network',
  deleteNetworkAsk: 'Ctrl+Z will not bring it back.',
  networkOff: 'Leave it in the block but do not execute it',
  networkOn: 'Put this network back into the program',
  noNetworks: 'This block has no networks yet.',
  addFirstNetwork: 'Add the first network',
  addCoil: '+ coil',
  openBranch: 'Open branch',
  openBranchNote: 'Everything in this column becomes an OR',
  openBranchHere: 'A parallel path around this element alone',
  closeBranch: 'Close branch',
  closeBranchNote: 'Carry on after the parallel group',
  deleteElement: 'Delete this element',
  deleteBranch: 'Delete this branch',
  deleteCoil: 'Delete this coil',
  copyElement: 'Copy',
  cutElement: 'Cut',
  pasteElement: 'Paste here',
  editKeysHint: 'Drag to move · Del removes · Ctrl+C / Ctrl+V · arrows move along the rung',
  contactNo: 'Normally open contact',
  contactNc: 'Normally closed contact',
  coil: 'Assignment',
  emptyBox: 'Empty box — drop it, then type the instruction name',
  clickThenPlace: '— click where it goes',
  putItBack: 'Put it back',
  placeHere: 'Put the chosen instruction here',
  clickThenPick: 'Click an instruction, then click where it goes.',
  instancePlaceholder: '<instance>',
  instanceTip: 'Where this instruction keeps its state. Two calls sharing one instance interfere.',
  boxTypeTip: 'The instruction. Type a name from the catalogue and its pins appear.',
  coilKindAssign: 'Assignment  -( )-',
  coilKindSet: 'Set  -(S)-',
  coilKindReset: 'Reset  -(R)-',
  coilKindP: 'Positive edge  -(P)-',
  coilKindN: 'Negative edge  -(N)-',

  searchInstructions: 'Search instructions…',
  favorites: 'Favorites',
  favoritesEmpty: 'Nothing here. The star on a row puts it in.',
  matches: 'matches',
  noMatches: 'Nothing in the catalogue matches that. The search looks at the name, the '
    + 'description and the help.',
  addFavorite: 'Put it in Favorites',
  removeFavorite: 'Take it out of Favorites',
  whatItDoes: 'What it does, and what goes wrong with it',
  needsInstance: 'Keeps its own state — it needs an instance of its own.',
  drawnOnly: 'Drawn only — there is no text form of this one.',
  editorCommand: 'An editor command, for a drawn network.',

  problems: 'Problems',
  output: 'Output',
  nothingWrong: 'Nothing the checker can see. That is not the same as the logic being right.',
  pressCheck: 'Nothing yet. Press Check.',
  closeStrip: 'Close this strip',
  show: 'show',
  errors: 'errors',
  warnings: 'warnings',
  notes: 'notes',
  blocksCount: 'blocks',
  readOnlyRevision: 'read-only revision',
  checkRunAt: 'Check run at',
  checkSummaryClean: 'No errors.',
  checkSummaryBad: 'errors found.',
  checkCaveat: 'This is what this app can check by reading the program: names, structure, types, '
    + 'addresses. It does not say the logic is right, and no checker can.',

  assistantTitle: 'Assistant',
  copyContext: 'Copy the program',
  copyContextTip: 'Copy the whole program as text, for pasting into another tool',
  copyContextDone: 'The program is on the clipboard — blocks, tags, problems and the instruction '
    + 'vocabulary. Paste it into whatever you are asking.',
  askPlaceholder: 'What should the program do?',
  ask: 'Ask',
  working: 'Working…',
  starterMotor: 'Write a motor start/stop block',
  starterExplain: 'Explain this block',
  starterFix: 'Fix what the checker found',
  onlyThisBlock: 'Only the open block',
  wholeProgram: 'The whole program',
  noBlockOpen: 'none is open',
  sendCatalogue: 'Send the instruction catalogue',
  sendCatalogueNote: 'Stops it inventing block names this controller has never heard of.',
  explainMore: 'Explain from further back',
  questionsIntro: 'It will not guess at these — each one changes the program.',
  answerAndGo: 'Answer and carry on',
  startAgain: 'Start again',
  newBlocks: 'New blocks',
  replacedBlocks: 'Blocks replaced',
  replacedNote: 'What is in the project under that name is overwritten.',
  newTags: 'New tags',
  changedTags: 'Tags whose address differs',
  changedTagsNote: "Left as they are — the wiring is not the assistant's to change.",
  afterApply: 'After applying, the checker would find',
  couldNotUse: 'What could not be used as it arrived',
  readBefore: 'Read before using this',
  addTheseTags: 'Add the new tag(s) to the default table',
  putInProject: 'Put it in the project',
  throwAway: 'Throw this away and ask again',
  whatItSaid: 'What it said',
  assistantCaveat: 'What comes back is a draft for an engineer to read. Nothing here has been '
    + 'checked against a controller, and a language model is not the right thing to trust with an '
    + 'interlock. Read it, test it, and do not download it because it looked right.',

  newBlockTitle: 'Add new block',
  whatKind: 'What kind of block?',
  whatCalls: 'What calls it?',
  whatFor: 'What is it for?',
  globalDb: 'Global',
  globalDbNote: 'Values anybody may read and write — recipes, setpoints, counters.',
  instanceDb: 'Instance',
  instanceDbNote: 'The memory of one call of one function block.',
  noFbYet: 'There is no function block to be an instance of yet.',
  whichFb: 'Which function block?',
  writtenIn: 'Written in',
  name: 'Name',
  number: 'Number',
  comment: 'Comment',
  addBlock: 'Add block',
  cancel: 'Cancel',
  giveItAName: 'Give it a name.',
  nameRules: 'Letters, digits and underscores, starting with a letter or an underscore.',
  nameAlreadyUsed: 'Something in this project is already called that.',
  instanceNeedsFb: 'An instance data block belongs to one function block — say which.',
  numberTaken: 'is already taken. It will still be created; two blocks with one number cannot '
    + 'both be downloaded.',

  kindOb: 'Organization block',
  kindFb: 'Function block',
  kindFc: 'Function',
  kindDb: 'Data block',
  kindUdt: 'PLC data type',
  kindObNote: 'The controller calls it — the cyclic program and the events',
  kindFbNote: 'Has a memory: its statics live in an instance data block',
  kindFcNote: 'Given values, gives one back, remembers nothing',
  kindDbNote: 'Values with no code — global, or the instance of one FB',
  kindUdtNote: 'A structure declared once and used as a type',
};

const FA: Strings = {
  lang: 'fa',

  pageTitle: 'PLC',
  startTitle: 'هنوز کنترلری در این پروژه نیست',
  startWhat: 'این صفحه برنامهٔ PLC تابلو را نگه می‌دارد: بلاک‌های سازمانی، فانکشن و دیتا، جدول '
    + 'تگ‌ها که سیم‌کشی را نام‌گذاری می‌کند، و کاتالوگ دستورها برای نوشتن آن‌ها. همراه پروژه ذخیره '
    + 'می‌شود، پس منطق و نقشه‌ها با هم جابه‌جا می‌شوند و پشتیبان هر دو را می‌برد.',
  startButton: 'ساختن کنترلر',
  startNote: 'با یک S7-1500 و OB1 و سه تگ شروع می‌شود. CPU، تگ‌ها و هر چیز دیگری بعداً قابل '
    + 'تغییر است.',
  startReadOnly: 'این رویژن فقط خواندنی است. برای شروع، یک رویژن قابل ویرایش باز کنید.',

  check: 'بررسی',
  checkTip: 'کل برنامه را می‌خواند و می‌گوید چه چیزی ایراد دارد',
  exportScl: 'خروجی SCL',
  exportSclTip: 'کل برنامه به صورت فایل سورس بیرونی',
  exportTags: 'CSV تگ‌ها',
  exportTagsTip: 'جدول تگ‌ها، به همان CSV که زیمنس می‌خواند',
  find: 'جست‌وجو (Ctrl+F)',
  replace: 'جست‌وجو و جایگزینی (Ctrl+H)',
  format: 'مرتب کردن تورفتگی بلاک (Shift+Alt+F)',
  commands: 'پالت فرمان‌ها (F1)',
  instructions: 'دستورها',
  assistant: 'دستیار',
  hideCatalogue: 'بستن کاتالوگ',
  hideAssistant: 'بستن دستیار',
  showTree: 'برگرداندن درخت پروژه',
  hideTree: 'بستن درخت پروژه',
  fullscreen: 'تمام‌صفحه',
  leaveFullscreen: 'خروج از تمام‌صفحه',
  deviceName: 'نام این کنترلر در پروژه',
  deviceCpu: 'CPU — متن آزاد، چون کاتالوگ مال کارفرماست',
  language: 'زبان',

  searchProject: 'جست‌وجو در پروژه',
  programBlocks: 'بلاک‌های برنامه',
  plcTags: 'تگ‌های PLC',
  plcDataTypes: 'نوع داده‌های PLC',
  addNewBlock: 'افزودن بلاک جدید',
  addNewDataType: 'افزودن نوع داده جدید',
  showAllTags: 'نمایش همهٔ تگ‌ها',
  obFolder: 'بلاک‌های سازمانی',
  fbFolder: 'فانکشن بلاک‌ها',
  fcFolder: 'فانکشن‌ها',
  dbFolder: 'دیتا بلاک‌ها',
  udtFolder: 'نوع داده‌های PLC',
  rename: 'تغییر نام…',
  renameTip: 'هر فراخوانی این بلاک هم با آن تغییر نام می‌دهد',
  duplicate: 'تکثیر',
  exportBlock: 'خروجی به صورت سورس SCL',
  del: 'حذف',
  renameAsk: 'نام تازهٔ این بلاک چه باشد؟',
  renameBadName: 'نام بلاک از حرف، رقم و زیرخط ساخته می‌شود و با حرف شروع می‌شود.',
  renameTaken: 'چیزی در این پروژه همین نام را دارد.',
  deleteAsk: 'حذف شود؟',
  deleteCannotUndo: 'این کار از اینجا برگشت‌پذیر نیست.',
  deleteInstances: 'دیتا بلاک نمونه، حافظهٔ هیچ چیزی می‌شود:',
  deleteCallers: 'بلاک آن را با نام صدا می‌زنند و دیگر کامپایل نمی‌شوند:',

  hideInterface: 'بستن اینترفیس',
  showInterface: 'نمایش اینترفیس',
  blockComment: 'این بلاک برای چیست',
  languageOf: 'بدنه با چه زبانی نوشته می‌شود. عوض کردنش آنچه هست را ترجمه نمی‌کند.',
  changeLanguageAsk: 'یکی کشیدنی است و دیگری نوشتنی. آنچه الان در بلاک است منتقل نمی‌شود — '
    + 'نگه داشته می‌شود ولی نمایش داده نمی‌شود. عوض شود؟',
  pickABlock: 'از سمت چپ یک بلاک انتخاب کنید، یا یکی اضافه کنید.',
  dbIsValues: 'دیتا بلاک فقط مقدار است و کد ندارد. ردیف‌های بالا خودِ بلاک‌اند.',
  udtIsStruct: 'نوع دادهٔ PLC یک ساختار است و کد ندارد. ردیف‌های بالا خودِ نوع‌اند.',
  instanceOf: 'این دیتا بلاکِ نمونهٔ این فانکشن بلاک است:',
  instanceEditThere: ' ردیف‌هایش همان اینترفیس آن فانکشن بلاک است — آنجا تغییرشان بدهید تا '
    + 'اینجا هم عوض شود. نسخه‌ای که دو جا ویرایش شود با خودش اختلاف پیدا می‌کند.',

  colName: 'نام',
  colType: 'نوع داده',
  colDefault: 'مقدار اولیه',
  colRetain: 'ماندگار',
  colVisible: 'قابل دیدن',
  colWritable: 'قابل نوشتن',
  colComment: 'توضیح',
  colAddress: 'آدرس',
  addTo: 'افزودن به',
  insertRowBelow: 'درج ردیف در پایین',
  moveUp: 'انتقال به بالا',
  moveDown: 'انتقال به پایین',
  deleteRow: 'حذف ردیف',
  nothingDeclaredFb: 'هنوز چیزی تعریف نشده. بلاکی که ورودی‌هایش را به صورت پارامتر می‌گیرد برای '
    + 'هر موتور تابلو قابل استفاده است؛ همان منطق اگر روی تگ‌های سراسری نوشته شود فقط یک بار.',
  nothingDeclaredOb: 'هنوز چیزی تعریف نشده. OB را کنترلر صدا می‌زند، پس آنچه به آن داده می‌شود '
    + 'ثابت است؛ Temp و Constant مال شماست.',
  nothingDeclaredDb: 'هنوز مقداری نیست. دیتا بلاک همان ردیف‌هایش است — آنچه برنامه باید نگه دارد '
    + 'را اضافه کنید.',
  nothingDeclaredUdt: 'هنوز عضوی نیست. نوع دادهٔ PLC یک بار اینجا تعریف می‌شود و هر جا آن شکل '
    + 'لازم است به عنوان نوع به کار می‌رود، پس تغییر آن همهٔ آن‌ها را تغییر می‌دهد.',
  namePlaceholder: 'نام',
  commentPlaceholder: 'برای چیست',
  retainTip: 'با قطع و وصل برق می‌ماند',
  retainOnlyStatic: 'فقط Static از قطع برق جان به در می‌برد',
  visibleTip: 'از HMI و OPC UA قابل دسترسی است',
  writableTip: 'از HMI قابل نوشتن است',

  secInput: 'Input — ورودی',
  secOutput: 'Output — خروجی',
  secInOut: 'InOut — ورودی/خروجی',
  secStatic: 'Static — ماندگار',
  secTemp: 'Temp — موقت',
  secConstant: 'Constant — ثابت',
  secReturn: 'Return — مقدار بازگشتی',
  secInputNote: 'فراخوان می‌دهد؛ اینجا فقط خواندنی است',
  secOutputNote: 'اینجا نوشته می‌شود؛ فراخوان می‌خواند',
  secInOutNote: 'با ارجاع داده می‌شود — اینجا نوشته می‌شود و فراخوان می‌بیند',
  secStaticNote: 'بعد از فراخوانی می‌ماند. فقط FB و DB — این همان حافظه است',
  secTempNote: 'فقط یک فراخوانی، و با مقدار آشغال شروع می‌شود. هرگز صفر فرض نکنید',
  secConstantNote: 'نامی برای یک مقدار ثابت',
  secReturnNote: 'تنها مقداری که فانکشن برمی‌گرداند',

  tagTable: 'جدول تگ',
  addTag: 'افزودن تگ',
  addTagNote: 'آدرس آخرین تگ ورودی ادامه داده می‌شود، پس یک ردیف ترمینال فقط با تایپ نام وارد '
    + 'می‌شود.',
  anotherTable: 'جدول تگ دیگر — برای گروه‌بندی تگ‌های یک تابلو',
  filter: 'فیلتر…',
  sortByAddress: 'مرتب‌سازی بر اساس آدرس — به ترتیب ترمینال‌ها',
  deleteTable: 'حذف این جدول',
  tableNameAsk: 'نام این جدول چه باشد؟',
  defaultTableKept: 'جدول پیش‌فرض جایی است که تگ‌های تازه در آن می‌نشینند — حذف نمی‌شود.',
  deleteTableAsk: 'این تعداد تگ دارد. خودش و آن‌ها حذف شوند؟',
  noTags: 'هنوز تگی نیست. قبل از نوشتن برنامه روی ترمینال‌ها، نامشان را بگذارید — فرق برنامه‌ای '
    + 'که خوانده می‌شود با برنامه‌ای که خوانده نمی‌شود همین است.',
  noTagMatches: 'هیچ تگی در این جدول با آن نمی‌خواند.',
  tagNamePlaceholder: 'Start_PB',
  tagCommentPlaceholder: 'این سیم برای چیست',

  network: 'شبکه',
  networkTitlePlaceholder: 'این شبکه برای چیست',
  networkCommentPlaceholder: 'توضیح — چرا این‌طور ساخته شده',
  addNetwork: 'افزودن شبکه',
  addNetworkAfter: 'درج شبکه بعد از این',
  duplicateNetwork: 'تکثیر شبکه',
  deleteNetwork: 'حذف شبکه',
  deleteNetworkAsk: 'با Ctrl+Z برنمی‌گردد.',
  networkOff: 'در بلاک بماند ولی اجرا نشود',
  networkOn: 'این شبکه به برنامه برگردد',
  noNetworks: 'این بلاک هنوز شبکه‌ای ندارد.',
  addFirstNetwork: 'افزودن اولین شبکه',
  addCoil: '+ کویل',
  openBranch: 'باز کردن شاخه',
  openBranchNote: 'هر چه در این ستون است OR می‌شود',
  openBranchHere: 'مسیر موازی فقط دور همین المان',
  closeBranch: 'بستن شاخه',
  closeBranchNote: 'ادامه دادن بعد از گروه موازی',
  deleteElement: 'حذف این المان',
  deleteBranch: 'حذف این شاخه',
  deleteCoil: 'حذف این کویل',
  copyElement: 'کپی',
  cutElement: 'برش',
  pasteElement: 'چسباندن اینجا',
  editKeysHint: 'با درگ جابه‌جا کنید · Del حذف می‌کند · Ctrl+C / Ctrl+V · کلیدهای جهت روی ریل حرکت می‌کنند',
  contactNo: 'کنتاکت باز (NO)',
  contactNc: 'کنتاکت بسته (NC)',
  coil: 'کویل — انتساب',
  emptyBox: 'باکس خالی — بگذارید و بعد نام دستور را تایپ کنید',
  clickThenPlace: '— روی جایش کلیک کنید',
  putItBack: 'برگرداندن',
  placeHere: 'دستور انتخاب‌شده اینجا گذاشته شود',
  clickThenPick: 'یک دستور را کلیک کنید، بعد روی جایش کلیک کنید.',
  instancePlaceholder: '<نمونه>',
  instanceTip: 'جایی که این دستور حالتش را نگه می‌دارد. دو فراخوانی با یک نمونه در هم می‌افتند.',
  boxTypeTip: 'دستور. نامی از کاتالوگ تایپ کنید تا پین‌هایش ظاهر شود.',
  coilKindAssign: 'انتساب  -( )-',
  coilKindSet: 'ست  -(S)-',
  coilKindReset: 'ریست  -(R)-',
  coilKindP: 'لبهٔ بالارونده  -(P)-',
  coilKindN: 'لبهٔ پایین‌رونده  -(N)-',

  searchInstructions: 'جست‌وجوی دستورها…',
  favorites: 'برگزیده‌ها',
  favoritesEmpty: 'اینجا چیزی نیست. ستارهٔ هر ردیف آن را اضافه می‌کند.',
  matches: 'نتیجه',
  noMatches: 'چیزی در کاتالوگ با آن نمی‌خواند. جست‌وجو نام، توضیح و راهنما را می‌بیند.',
  addFavorite: 'افزودن به برگزیده‌ها',
  removeFavorite: 'برداشتن از برگزیده‌ها',
  whatItDoes: 'چه می‌کند و کجا اشتباه می‌شود',
  needsInstance: 'حالت خودش را نگه می‌دارد — نمونهٔ مخصوص خودش را می‌خواهد.',
  drawnOnly: 'فقط کشیدنی — شکل متنی ندارد.',
  editorCommand: 'یک فرمان ویرایشگر، برای شبکهٔ کشیدنی.',

  problems: 'ایرادها',
  output: 'خروجی',
  nothingWrong: 'چیزی که بررسی‌کننده ببیند نیست. این یعنی منطق درست است نیست.',
  pressCheck: 'هنوز چیزی نیست. «بررسی» را بزنید.',
  closeStrip: 'بستن این نوار',
  show: 'نمایش',
  errors: 'خطا',
  warnings: 'هشدار',
  notes: 'نکته',
  blocksCount: 'بلاک',
  readOnlyRevision: 'رویژن فقط‌خواندنی',
  checkRunAt: 'بررسی در ساعت',
  checkSummaryClean: 'بدون خطا.',
  checkSummaryBad: 'خطا پیدا شد.',
  checkCaveat: 'این چیزی است که این برنامه با خواندن کد می‌تواند بررسی کند: نام‌ها، ساختار، '
    + 'نوع‌ها، آدرس‌ها. نمی‌گوید منطق درست است، و هیچ بررسی‌کننده‌ای نمی‌تواند بگوید.',

  assistantTitle: 'دستیار',
  copyContext: 'کپی برنامه',
  copyContextTip: 'کپی کل برنامه به صورت متن، برای پیست در ابزار دیگر',
  copyContextDone: 'برنامه روی کلیپ‌بورد است — بلاک‌ها، تگ‌ها، ایرادها و واژگان دستورها. در هر '
    + 'جایی که می‌پرسید پیست کنید.',
  askPlaceholder: 'برنامه چه کار باید بکند؟',
  ask: 'بپرس',
  working: 'در حال کار…',
  starterMotor: 'یک بلاک استارت/استاپ موتور بنویس',
  starterExplain: 'این بلاک را توضیح بده',
  starterFix: 'ایرادهایی که بررسی پیدا کرد را درست کن',
  onlyThisBlock: 'فقط بلاک باز',
  wholeProgram: 'کل برنامه',
  noBlockOpen: 'چیزی باز نیست',
  sendCatalogue: 'فرستادن کاتالوگ دستورها',
  sendCatalogueNote: 'جلوی ساختن نام بلاکی که این کنترلر ندارد را می‌گیرد.',
  explainMore: 'از عقب‌تر توضیح بده',
  questionsIntro: 'این‌ها را حدس نمی‌زند — هر کدام برنامه را عوض می‌کند.',
  answerAndGo: 'پاسخ و ادامه',
  startAgain: 'از نو',
  newBlocks: 'بلاک‌های جدید',
  replacedBlocks: 'بلاک‌های بازنویسی‌شده',
  replacedNote: 'آنچه در پروژه با آن نام هست، رونویسی می‌شود.',
  newTags: 'تگ‌های جدید',
  changedTags: 'تگ‌هایی که آدرسشان فرق دارد',
  changedTagsNote: 'دست‌نخورده می‌مانند — سیم‌کشی کار دستیار نیست.',
  afterApply: 'بعد از اعمال، بررسی‌کننده این‌ها را پیدا می‌کند:',
  couldNotUse: 'آنچه به همان شکل که آمد قابل استفاده نبود',
  readBefore: 'قبل از استفاده بخوانید',
  addTheseTags: 'تگ‌های جدید به جدول پیش‌فرض اضافه شوند',
  putInProject: 'در پروژه گذاشته شود',
  throwAway: 'دور ریختن و دوباره پرسیدن',
  whatItSaid: 'چه گفت',
  assistantCaveat: 'آنچه برمی‌گردد پیش‌نویسی است برای خواندن مهندس. هیچ چیز اینجا روی کنترلر '
    + 'آزمایش نشده، و مدل زبانی چیز درستی برای سپردن یک اینترلاک نیست. بخوانید، تست کنید، و '
    + 'چون درست به نظر می‌رسید دانلودش نکنید.',

  newBlockTitle: 'افزودن بلاک جدید',
  whatKind: 'چه نوع بلاکی؟',
  whatCalls: 'چه چیزی آن را صدا می‌زند؟',
  whatFor: 'برای چیست؟',
  globalDb: 'سراسری',
  globalDbNote: 'مقادیری که همه می‌خوانند و می‌نویسند — رسپی، ست‌پوینت، شمارنده.',
  instanceDb: 'نمونه',
  instanceDbNote: 'حافظهٔ یک فراخوانی از یک فانکشن بلاک.',
  noFbYet: 'هنوز فانکشن بلاکی نیست که نمونه‌اش باشد.',
  whichFb: 'کدام فانکشن بلاک؟',
  writtenIn: 'نوشته‌شده با',
  name: 'نام',
  number: 'شماره',
  comment: 'توضیح',
  addBlock: 'افزودن بلاک',
  cancel: 'انصراف',
  giveItAName: 'نامی برایش بگذارید.',
  nameRules: 'حرف، رقم و زیرخط، با شروع از حرف یا زیرخط.',
  nameAlreadyUsed: 'چیزی در این پروژه همین نام را دارد.',
  instanceNeedsFb: 'دیتا بلاک نمونه به یک فانکشن بلاک تعلق دارد — بگویید کدام.',
  numberTaken: 'قبلاً گرفته شده. باز هم ساخته می‌شود؛ ولی دو بلاک با یک شماره با هم دانلود '
    + 'نمی‌شوند.',

  kindOb: 'بلاک سازمانی',
  kindFb: 'فانکشن بلاک',
  kindFc: 'فانکشن',
  kindDb: 'دیتا بلاک',
  kindUdt: 'نوع دادهٔ PLC',
  kindObNote: 'کنترلر صدایش می‌زند — برنامهٔ چرخه‌ای و رویدادها',
  kindFbNote: 'حافظه دارد: Static‌هایش در یک دیتا بلاک نمونه می‌نشینند',
  kindFcNote: 'مقدار می‌گیرد، یکی برمی‌گرداند، چیزی یادش نمی‌ماند',
  kindDbNote: 'مقدار بدون کد — سراسری، یا نمونهٔ یک FB',
  kindUdtNote: 'ساختاری که یک بار تعریف می‌شود و به عنوان نوع به کار می‌رود',
};

export const STRINGS: Record<Lang, Strings> = { en: EN, fa: FA };

/**
 * The language, remembered in the browser.
 *
 * Its own key, separate from the drawing editor's: somebody may well read the
 * ladder in Persian and the CAD toolbar in English, and neither choice is the
 * other's business.
 */
const KEY = 'simorgh-plc-lang';

export function loadLang(): Lang {
  try {
    const kept = window.localStorage.getItem(KEY);
    if (kept === 'en' || kept === 'fa') return kept;
  } catch { /* a browser that will not keep anything is not an error */ }
  return 'en';
}

export function saveLang(l: Lang): void {
  try { window.localStorage.setItem(KEY, l); } catch { /* nothing to do */ }
}
