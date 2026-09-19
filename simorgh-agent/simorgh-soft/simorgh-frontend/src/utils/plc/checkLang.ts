// src/utils/plc/checkLang.ts
//
// What the checker says, in the language the engineer is reading.
//
// This is the one part of the page worth translating most carefully. The
// problems list is not decoration — it is where somebody looks when something
// is wrong, usually in a hurry, and a message that is nearly understood is a
// message acted on wrongly. So each one is a function rather than a template
// with holes in it: Persian and English do not put the name, the number and
// the verb in the same order, and a sentence assembled from fragments comes
// out as neither language.
//
// **The names stay as they are.** `%I0.0`, `TON`, `END_IF`, `Bool` and the
// block's own name are quoted into the sentence untouched, in both languages,
// because they are what the engineer has to go and look at.
//
// A message added to one language and not the other is a type error, which is
// the whole reason this is an interface.

export interface CheckStrings {
  // ── SCL structure ──
  unopened: (close: string, wants: string) => string;
  mismatch: (close: string, wants: string, open: string, line: number) => string;
  unclosed: (open: string, line: number) => string;

  // ── SCL names ──
  undeclared: (name: string) => string;
  unknownName: (name: string) => string;
  unknownCall: (name: string) => string;
  writeInput: (name: string) => string;
  writeConstant: (name: string) => string;
  divZero: () => string;
  realEquality: () => string;

  // ── The declarations ──
  ifaceNoName: () => string;
  ifaceBadName: (name: string) => string;
  ifaceDuplicate: (name: string) => string;
  ifaceBadSection: (name: string, section: string, kind: string, allowed: string) => string;
  ifaceUnknownUserType: (name: string, type: string) => string;
  ifaceUnknownType: (name: string, type: string) => string;
  ifaceTempDefault: (name: string) => string;
  ifaceRetain: (name: string) => string;
  fcNoReturn: (block: string, ret: string) => string;

  // ── The rung ──
  ladUnknownBlock: (network: number, type: string) => string;
  ladNoInstance: (network: number, type: string) => string;
  ladNoOperand: (network: number) => string;
  ladNoCoilOperand: (network: number) => string;
  ladUnknownOperand: (network: number, operand: string) => string;
  ladNoOutput: (network: number) => string;
  ladAlwaysOn: (network: number) => string;
  ladNoTitle: (network: number) => string;
  ladEmptyBranch: (network: number, column: number) => string;

  // ── The project ──
  duplicateBlock: (name: string, count: number) => string;
  badAddress: (tag: string, why: string) => string;
  duplicateAddress: (address: string, count: number, names: string) => string;
  tagTypeWidthBit: (tag: string, address: string, type: string) => string;
  tagTypeWidthBool: (tag: string, address: string) => string;

  // ── What an address is wrong about ──
  addrNoPercent: () => string;
  addrNeedsBit: () => string;
  addrDbNeedsBit: () => string;
  addrNotS7: () => string;
  addrOnlyBitHasBit: () => string;
  addrBitRange: () => string;
}

const EN: CheckStrings = {
  unopened: (close, wants) => `${close} with no ${wants} open before it.`,
  mismatch: (close, wants, open, line) =>
    `${close} closes ${wants}, but what is open is ${open} from line ${line}.`,
  unclosed: (open, line) => `${open} on line ${line} is never closed — add END_${open}.`,

  undeclared: name => `#${name} is not declared in this block. Add it to the interface above, `
    + 'or correct the spelling.',
  unknownName: name => `"${name}" is not a block, a PLC data type or a tag in this project. `
    + 'It will not compile until it exists.',
  unknownCall: name => `${name} is not an instruction this controller has and not a block in `
    + 'this project. Check the spelling against the instruction catalogue.',
  writeInput: name => `#${name} is an Input — it is given by the caller and cannot be written `
    + 'here. Use an InOut if the caller should see the change.',
  writeConstant: name => `#${name} is a Constant and cannot be written.`,
  divZero: () => 'Division by zero. On an integer this faults the CPU rather than returning '
    + 'anything.',
  realEquality: () => 'Two floating-point numbers compared for equality. They are almost never '
    + 'exactly equal — compare ABS(a - b) against a tolerance instead.',

  ifaceNoName: () => 'A declared row with no name.',
  ifaceBadName: name => `"${name}" is not a name a controller will take — letters, digits and `
    + 'underscores, starting with a letter or an underscore.',
  ifaceDuplicate: name => `${name} is declared twice. Whichever the compiler picks, one of the `
    + 'two uses in the code is not the one that was meant.',
  ifaceBadSection: (name, section, kind, allowed) =>
    `${name} is in ${section}, which a ${kind} does not have. A ${kind} declares ${allowed}.`,
  ifaceUnknownUserType: (name, type) => `${name} is declared as "${type}", which is not a PLC `
    + 'data type or a function block in this project.',
  ifaceUnknownType: (name, type) => `${name} has the type "${type}", which is not one this `
    + 'controller knows.',
  ifaceTempDefault: name => `${name} is Temp and has a start value. Temp is not initialised — `
    + 'it holds whatever was in that memory last scan, and the start value is ignored.',
  ifaceRetain: name => `${name} is marked retentive but is not Static. Only Static survives a `
    + 'power cycle.',
  fcNoReturn: (block, ret) => `${block} declares a return value (${ret}) and never assigns it. `
    + 'The caller gets whatever was there.',

  ladUnknownBlock: (n, type) => `Network ${n}: ${type} is not an instruction and not a block in `
    + 'this project.',
  ladNoInstance: (n, type) => `Network ${n}: ${type} keeps its state somewhere and has no `
    + 'instance. Give it one, or two calls will share a memory and interfere.',
  ladNoOperand: n => `Network ${n}: a contact with no operand. It tests nothing.`,
  ladNoCoilOperand: n => `Network ${n}: a coil with no operand. It drives nothing.`,
  ladUnknownOperand: (n, operand) => `Network ${n}: ${operand} is not a tag or a variable this `
    + 'block can see.',
  ladNoOutput: n => `Network ${n} works out a condition and does nothing with it — there is no `
    + 'coil or box at the end.',
  ladAlwaysOn: n => `Network ${n} has nothing in the condition, so its output is on every scan. `
    + 'Intended for an enable; worth a look otherwise.',
  ladNoTitle: n => `Network ${n} has no title. A program is read far more often than it is `
    + 'written.',
  ladEmptyBranch: (n, column) => `Network ${n}: column ${column} has a parallel path with nothing `
    + 'in it, which is a wire straight through — everything beside it is bypassed.',

  duplicateBlock: (name, count) => `${name} is the name of ${count} blocks. A call by that name `
    + 'cannot be resolved.',
  badAddress: (tag, why) => `${tag}: ${why}`,
  duplicateAddress: (address, count, names) => `${address} is named by ${count} tags (${names}). `
    + 'Two names for one terminal is how a change gets made in one place and not the other.',
  tagTypeWidthBit: (tag, address, type) => `${tag} is at ${address}, which is one bit, but is `
    + `declared ${type}.`,
  tagTypeWidthBool: (tag, address) => `${tag} is declared Bool but ${address} has no bit number.`,

  addrNoPercent: () => 'An address starts with % — %I0.0, %QW64, %MD100.',
  addrNeedsBit: () => 'A bit address needs a bit number — %I0.0, not %I0.',
  addrDbNeedsBit: () => 'A bit in a DB needs a bit number — %DB1.DBX0.0.',
  addrNotS7: () => 'That is not an S7 address. Try %I0.0, %QW64 or %MD100.',
  addrOnlyBitHasBit: () => 'Only a bit address has a bit number — %IW64, not %IW64.0.',
  addrBitRange: () => 'A bit number is 0 to 7.',
};

const FA: CheckStrings = {
  unopened: (close, wants) => `${close} بدون اینکه ${wants} پیش از آن باز شده باشد.`,
  mismatch: (close, wants, open, line) =>
    `${close} باید ${wants} را ببندد، ولی آنچه باز است ${open} از خط ${line} است.`,
  unclosed: (open, line) => `${open} در خط ${line} هیچ‌وقت بسته نمی‌شود — END_${open} اضافه کنید.`,

  undeclared: name => `‏#${name} در این بلاک تعریف نشده. در اینترفیس بالا اضافه‌اش کنید، یا `
    + 'املایش را درست کنید.',
  unknownName: name => `‏"${name}" نه بلاک است، نه نوع دادهٔ PLC و نه تگی در این پروژه. تا وقتی `
    + 'وجود نداشته باشد کامپایل نمی‌شود.',
  unknownCall: name => `‏${name} نه دستوری است که این کنترلر داشته باشد و نه بلاکی در این پروژه. `
    + 'املایش را با کاتالوگ دستورها بسنجید.',
  writeInput: name => `‏#${name} یک Input است — فراخوان آن را می‌دهد و اینجا نمی‌شود در آن نوشت. `
    + 'اگر فراخوان باید تغییر را ببیند از InOut استفاده کنید.',
  writeConstant: name => `‏#${name} یک Constant است و نوشتنی نیست.`,
  divZero: () => 'تقسیم بر صفر. روی عدد صحیح، CPU خطا می‌دهد و چیزی برنمی‌گرداند.',
  realEquality: () => 'دو عدد اعشاری با هم برابر گرفته شده‌اند. تقریباً هیچ‌وقت دقیقاً برابر '
    + 'نمی‌شوند — به جایش ABS(a - b) را با یک تلورانس مقایسه کنید.',

  ifaceNoName: () => 'ردیفی تعریف شده که نام ندارد.',
  ifaceBadName: name => `‏"${name}" نامی نیست که کنترلر بپذیرد — حرف، رقم و زیرخط، با شروع از `
    + 'حرف یا زیرخط.',
  ifaceDuplicate: name => `‏${name} دو بار تعریف شده. کامپایلر هر کدام را بردارد، یکی از دو `
    + 'استفادهٔ داخل کد آن چیزی نیست که منظور بوده.',
  ifaceBadSection: (name, section, kind, allowed) =>
    `‏${name} در ${section} است، ولی ${kind} چنین بخشی ندارد. یک ${kind} این‌ها را تعریف `
    + `می‌کند: ${allowed}.`,
  ifaceUnknownUserType: (name, type) => `‏${name} با نوع "${type}" تعریف شده، که نه نوع دادهٔ `
    + 'PLC است و نه فانکشن بلاکی در این پروژه.',
  ifaceUnknownType: (name, type) => `‏${name} نوع "${type}" دارد، که این کنترلر آن را `
    + 'نمی‌شناسد.',
  ifaceTempDefault: name => `‏${name} در Temp است و مقدار اولیه دارد. Temp مقداردهی اولیه `
    + 'نمی‌شود — هر چه اسکن قبل در آن حافظه بوده را نگه می‌دارد و مقدار اولیه نادیده گرفته '
    + 'می‌شود.',
  ifaceRetain: name => `‏${name} ماندگار علامت خورده ولی Static نیست. فقط Static از قطع برق `
    + 'جان به در می‌برد.',
  fcNoReturn: (block, ret) => `‏${block} یک مقدار بازگشتی (${ret}) تعریف می‌کند و هیچ‌وقت به آن `
    + 'مقدار نمی‌دهد. فراخوان هر چه آنجا بوده را می‌گیرد.',

  ladUnknownBlock: (n, type) => `شبکهٔ ${n}: ${type} نه دستور است و نه بلاکی در این پروژه.`,
  ladNoInstance: (n, type) => `شبکهٔ ${n}: ${type} حالتش را جایی نگه می‌دارد و نمونه ندارد. یکی `
    + 'برایش بگذارید، وگرنه دو فراخوانی یک حافظه را شریک می‌شوند و در هم می‌افتند.',
  ladNoOperand: n => `شبکهٔ ${n}: کنتاکتی بدون عملوند. چیزی را نمی‌خواند.`,
  ladNoCoilOperand: n => `شبکهٔ ${n}: کویلی بدون عملوند. چیزی را راه نمی‌اندازد.`,
  ladUnknownOperand: (n, operand) => `شبکهٔ ${n}: ${operand} نه تگ است و نه متغیری که این بلاک `
    + 'ببیند.',
  ladNoOutput: n => `شبکهٔ ${n} یک شرط حساب می‌کند و کاری با آن نمی‌کند — در انتهایش کویل یا `
    + 'باکسی نیست.',
  ladAlwaysOn: n => `شبکهٔ ${n} در شرطش چیزی ندارد، پس خروجی‌اش هر اسکن وصل است. اگر برای یک `
    + 'enable است اشکالی ندارد؛ در غیر این صورت یک نگاه می‌ارزد.',
  ladNoTitle: n => `شبکهٔ ${n} عنوان ندارد. برنامه خیلی بیشتر از آنکه نوشته شود خوانده می‌شود.`,
  ladEmptyBranch: (n, column) => `شبکهٔ ${n}: ستون ${column} یک مسیر موازی خالی دارد، که یعنی سیم `
    + 'مستقیم — هر چه کنارش هست دور زده می‌شود.',

  duplicateBlock: (name, count) => `‏${name} نام ${count} بلاک است. فراخوانی با این نام معلوم `
    + 'نمی‌شود به کدام می‌رود.',
  badAddress: (tag, why) => `‏${tag}: ${why}`,
  duplicateAddress: (address, count, names) => `‏${address} نام ${count} تگ است (${names}). دو نام `
    + 'برای یک ترمینال یعنی تغییری که یک جا انجام می‌شود و جای دیگر نه.',
  tagTypeWidthBit: (tag, address, type) => `‏${tag} روی ${address} است که یک بیت است، ولی با نوع `
    + `${type} تعریف شده.`,
  tagTypeWidthBool: (tag, address) => `‏${tag} با نوع Bool تعریف شده ولی ${address} شمارهٔ بیت `
    + 'ندارد.',

  addrNoPercent: () => 'آدرس با ٪ شروع می‌شود — ‎%I0.0‎، ‎%QW64‎، ‎%MD100‎.',
  addrNeedsBit: () => 'آدرس بیتی شمارهٔ بیت می‌خواهد — ‎%I0.0‎، نه ‎%I0‎.',
  addrDbNeedsBit: () => 'یک بیت داخل DB شمارهٔ بیت می‌خواهد — ‎%DB1.DBX0.0‎.',
  addrNotS7: () => 'این آدرس S7 نیست. ‎%I0.0‎ یا ‎%QW64‎ یا ‎%MD100‎ را امتحان کنید.',
  addrOnlyBitHasBit: () => 'فقط آدرس بیتی شمارهٔ بیت دارد — ‎%IW64‎، نه ‎%IW64.0‎.',
  addrBitRange: () => 'شمارهٔ بیت از ۰ تا ۷ است.',
};

export const CHECK_STRINGS: Record<'en' | 'fa', CheckStrings> = { en: EN, fa: FA };
