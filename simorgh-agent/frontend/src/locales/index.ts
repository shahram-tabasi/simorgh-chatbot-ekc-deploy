// src/locales/index.ts
// Phase-1 i18n dictionary for the most-visited UI surfaces:
//   - sidebar headers, new-chat buttons
//   - welcome / empty states
//   - chat input placeholder + send / stop / mic tooltips
//   - settings panel labels
//   - mobile header dropdown items
//   - common error messages (project create, login)
// Renameable chat titles, AI message content, and chat summaries are
// intentionally NOT translated — those are user/LLM-generated.
export type Language = 'en' | 'fa' | 'de';

export interface Dict {
  // Sidebar / project tree
  general: string;
  projects: string;
  newProject: string;
  newChat: string;
  newGeneralChat: string;
  newProjectChat: string;
  noProjectsYet: string;
  active: string;
  archived: string;
  all: string;
  history: string;
  search: string;
  chatHistory: string;
  listProjects: string;

  // Welcome / empty states
  welcomeTagline: string;       // "برای شروع روی یکی از موضوعات زیر کلیک کنید"
  welcomeSubtitle: string;      // "Ask me anything..."
  startBelow: string;

  // Chat input
  sendPlaceholder: string;
  sendDisabledPlaceholder: string;
  send: string;
  stopGenerating: string;
  attachFiles: string;
  recordVoice: string;
  stopRecording: string;
  transcribing: string;
  typing: string;

  // Settings panel
  settings: string;
  language: string;
  english: string;
  persian: string;
  german: string;
  aiMode: string;
  onlineAI: string;
  onlineAIDesc: string;
  localAI: string;
  localAIDesc: string;
  theme: string;
  notifications: string;
  notificationsEnabled: string;
  notificationsDisabled: string;
  account: string;
  logout: string;
  changeAvatar: string;
  uploadPhoto: string;
  pickAvatar: string;
  avatarSaved: string;

  // User profile
  signedInAs: string;
  role: string;
  yourPlan: string;
  upgradePlan: string;

  // Auth pages
  signIn: string;
  signUp: string;
  signingIn: string;
  signingUp: string;
  emailAddress: string;
  password: string;
  rememberMe: string;
  forgotPassword: string;
  continueWithGoogle: string;
  orContinueWithEmail: string;
  dontHaveAccount: string;
  alreadyHaveAccount: string;
  createAccount: string;
  welcomeBack: string;

  // Errors (project create + generic)
  errPermission: string;
  errSessionExpired: string;
  errDuplicate: string;
  errInvalid: string;
  errNotFound: string;
  errNetwork: string;
  errGeneric: string;
  errProjectCreate: string;

  // Quota
  dailyQuotaExceeded: string;
  resetsAtMidnight: string;

  // Common verbs / actions
  save: string;
  cancel: string;
  delete: string;
  rename: string;
  confirm: string;
  close: string;
  retry: string;
  ok: string;
}

export const translations: Record<Language, Dict> = {
  en: {
    general: 'General',
    projects: 'Projects',
    newProject: 'New Project',
    newChat: 'New Chat',
    newGeneralChat: 'New general chat',
    newProjectChat: 'New project chat',
    noProjectsYet: 'No projects yet. Tap + New project to start.',
    active: 'Active',
    archived: 'Archived',
    all: 'All',
    history: 'History',
    search: 'Search',
    chatHistory: 'Chat History',
    listProjects: 'List Projects',

    welcomeTagline: 'Click any topic below to get started',
    welcomeSubtitle: 'Ask me anything about HR, leave policies, or strategy',
    startBelow: 'Pick a topic to begin',

    sendPlaceholder: 'Ask Simorgh anything...',
    sendDisabledPlaceholder: 'Please create or select a chat to start messaging...',
    send: 'Send',
    stopGenerating: 'Stop generating',
    attachFiles: 'Attach files',
    recordVoice: 'Start voice recording',
    stopRecording: 'Stop recording',
    transcribing: 'Transcribing...',
    typing: 'Typing...',

    settings: 'Settings',
    language: 'Language',
    english: 'English',
    persian: 'Persian',
    german: 'German',
    aiMode: 'AI Mode',
    onlineAI: 'Online AI',
    onlineAIDesc: 'Cloud processing with the latest models',
    localAI: 'Local AI',
    localAIDesc: 'On-premise, private inference',
    theme: 'Theme',
    notifications: 'Notifications',
    notificationsEnabled: 'Notifications enabled',
    notificationsDisabled: 'Enable notifications',
    account: 'Account',
    logout: 'Log out',
    changeAvatar: 'Change avatar',
    uploadPhoto: 'Upload photo',
    pickAvatar: 'Pick an avatar',
    avatarSaved: 'Avatar saved',

    signedInAs: 'Signed in as',
    role: 'Role',
    yourPlan: 'Your plan',
    upgradePlan: 'Upgrade plan',

    signIn: 'Sign in',
    signUp: 'Sign up',
    signingIn: 'Signing in...',
    signingUp: 'Creating account...',
    emailAddress: 'Email address',
    password: 'Password',
    rememberMe: 'Remember me for 30 days',
    forgotPassword: 'Forgot password?',
    continueWithGoogle: 'Continue with Google',
    orContinueWithEmail: 'or continue with email',
    dontHaveAccount: "Don't have an account?",
    alreadyHaveAccount: 'Already have an account?',
    createAccount: 'Create account',
    welcomeBack: 'Welcome back',

    errPermission:
      'Your account is not allowed to create projects. This feature is enabled for technical experts only — please contact your administrator.',
    errSessionExpired: 'Your session has expired. Please sign in again.',
    errDuplicate: 'A project with this name already exists. Please pick another name.',
    errInvalid: 'Some fields are missing or invalid. Please check and try again.',
    errNotFound:
      'The requested resource was not found. If you picked a GitLab repo, check your token and access.',
    errNetwork: 'Could not reach the server. Please try again in a moment.',
    errGeneric: 'Something went wrong. Please try again or contact support.',
    errProjectCreate: 'Could not create the project. Please try again.',

    dailyQuotaExceeded: 'Daily quota exceeded.',
    resetsAtMidnight: 'Resets at midnight UTC.',

    save: 'Save',
    cancel: 'Cancel',
    delete: 'Delete',
    rename: 'Rename',
    confirm: 'Confirm',
    close: 'Close',
    retry: 'Retry',
    ok: 'OK',
  },

  fa: {
    general: 'جنرال',
    projects: 'پروژه‌ها',
    newProject: 'پروژه جدید',
    newChat: 'چت جدید',
    newGeneralChat: 'چت جنرال جدید',
    newProjectChat: 'چت پروژه جدید',
    noProjectsYet: 'هنوز پروژه‌ای ندارید. روی + پروژه جدید بزنید.',
    active: 'فعال',
    archived: 'بایگانی',
    all: 'همه',
    history: 'تاریخچه',
    search: 'جستجو',
    chatHistory: 'تاریخچه چت',
    listProjects: 'لیست پروژه‌ها',

    welcomeTagline: 'برای شروع روی یکی از موضوعات زیر کلیک کنید',
    welcomeSubtitle: 'هر سوالی در مورد منابع انسانی، مرخصی یا استراتژی دارید بپرسید',
    startBelow: 'یک موضوع را برای شروع انتخاب کنید',

    sendPlaceholder: 'هرچه می‌خواهید از سیمرغ بپرسید...',
    sendDisabledPlaceholder: 'برای شروع گفتگو، یک چت بسازید یا انتخاب کنید...',
    send: 'ارسال',
    stopGenerating: 'توقف تولید',
    attachFiles: 'پیوست فایل',
    recordVoice: 'ضبط صدا',
    stopRecording: 'توقف ضبط',
    transcribing: 'در حال تبدیل صدا به متن...',
    typing: 'در حال تایپ...',

    settings: 'تنظیمات',
    language: 'زبان',
    english: 'انگلیسی',
    persian: 'فارسی',
    german: 'آلمانی',
    aiMode: 'حالت هوش مصنوعی',
    onlineAI: 'هوش آنلاین',
    onlineAIDesc: 'پردازش ابری با مدل‌های جدید',
    localAI: 'هوش محلی',
    localAIDesc: 'پردازش امن روی سرور داخلی',
    theme: 'تم',
    notifications: 'اعلان‌ها',
    notificationsEnabled: 'اعلان‌ها فعال هستند',
    notificationsDisabled: 'فعال‌سازی اعلان‌ها',
    account: 'حساب کاربری',
    logout: 'خروج',
    changeAvatar: 'تغییر آواتار',
    uploadPhoto: 'بارگذاری عکس',
    pickAvatar: 'انتخاب آواتار',
    avatarSaved: 'آواتار ذخیره شد',

    signedInAs: 'وارد شده با حساب',
    role: 'نقش',
    yourPlan: 'پلن شما',
    upgradePlan: 'ارتقاء پلن',

    signIn: 'ورود',
    signUp: 'ثبت نام',
    signingIn: 'در حال ورود...',
    signingUp: 'در حال ساخت حساب...',
    emailAddress: 'ایمیل',
    password: 'رمز عبور',
    rememberMe: 'به مدت ۳۰ روز مرا به خاطر بسپار',
    forgotPassword: 'رمز عبور را فراموش کرده‌اید؟',
    continueWithGoogle: 'ادامه با گوگل',
    orContinueWithEmail: 'یا ادامه با ایمیل',
    dontHaveAccount: 'حساب کاربری ندارید؟',
    alreadyHaveAccount: 'قبلاً ثبت‌نام کرده‌اید؟',
    createAccount: 'ساخت حساب',
    welcomeBack: 'خوش آمدید',

    errPermission:
      'حساب شما اجازه ساخت پروژه را ندارد. ساخت پروژه فقط برای کارشناسان فنی فعال است — لطفاً با مدیر سیستم تماس بگیرید.',
    errSessionExpired: 'نشست شما منقضی شده است. لطفاً دوباره وارد شوید.',
    errDuplicate: 'پروژه‌ای با همین نام از قبل وجود دارد. لطفاً نام دیگری انتخاب کنید.',
    errInvalid: 'اطلاعات وارد شده کامل یا معتبر نیست. لطفاً فیلدها را بررسی و دوباره تلاش کنید.',
    errNotFound:
      'منبع درخواست‌شده پیدا نشد. اگر مخزن گیت‌لب انتخاب کرده‌اید، توکن و دسترسی را بررسی کنید.',
    errNetwork: 'ارتباط با سرور برقرار نشد. لطفاً چند لحظه دیگر دوباره تلاش کنید.',
    errGeneric: 'متأسفانه خطایی رخ داد. لطفاً دوباره تلاش کنید یا با پشتیبانی تماس بگیرید.',
    errProjectCreate: 'ساخت پروژه با خطا مواجه شد. لطفاً دوباره تلاش کنید.',

    dailyQuotaExceeded: 'سهمیه روزانه شما به پایان رسیده است.',
    resetsAtMidnight: 'تا نیمه‌شب (UTC) بازنشانی می‌شود.',

    save: 'ذخیره',
    cancel: 'انصراف',
    delete: 'حذف',
    rename: 'تغییر نام',
    confirm: 'تایید',
    close: 'بستن',
    retry: 'تلاش دوباره',
    ok: 'باشه',
  },

  de: {
    general: 'Allgemein',
    projects: 'Projekte',
    newProject: 'Neues Projekt',
    newChat: 'Neuer Chat',
    newGeneralChat: 'Neuer allgemeiner Chat',
    newProjectChat: 'Neuer Projekt-Chat',
    noProjectsYet: 'Noch keine Projekte. Tippen Sie auf + Neues Projekt.',
    active: 'Aktiv',
    archived: 'Archiviert',
    all: 'Alle',
    history: 'Verlauf',
    search: 'Suchen',
    chatHistory: 'Chat-Verlauf',
    listProjects: 'Projekte auflisten',

    welcomeTagline: 'Klicken Sie unten auf ein Thema, um zu starten',
    welcomeSubtitle: 'Fragen Sie mich zu Personal, Urlaub oder Strategie',
    startBelow: 'Wählen Sie ein Thema zum Starten',

    sendPlaceholder: 'Fragen Sie Simorgh alles...',
    sendDisabledPlaceholder: 'Bitte erstellen oder wählen Sie einen Chat aus...',
    send: 'Senden',
    stopGenerating: 'Generierung stoppen',
    attachFiles: 'Dateien anhängen',
    recordVoice: 'Sprachaufnahme starten',
    stopRecording: 'Aufnahme stoppen',
    transcribing: 'Wird transkribiert...',
    typing: 'Schreibt...',

    settings: 'Einstellungen',
    language: 'Sprache',
    english: 'Englisch',
    persian: 'Persisch',
    german: 'Deutsch',
    aiMode: 'KI-Modus',
    onlineAI: 'Online-KI',
    onlineAIDesc: 'Cloud-Verarbeitung mit neuesten Modellen',
    localAI: 'Lokale KI',
    localAIDesc: 'Sichere Verarbeitung auf dem internen Server',
    theme: 'Design',
    notifications: 'Benachrichtigungen',
    notificationsEnabled: 'Benachrichtigungen aktiviert',
    notificationsDisabled: 'Benachrichtigungen aktivieren',
    account: 'Konto',
    logout: 'Abmelden',
    changeAvatar: 'Avatar ändern',
    uploadPhoto: 'Foto hochladen',
    pickAvatar: 'Avatar wählen',
    avatarSaved: 'Avatar gespeichert',

    signedInAs: 'Angemeldet als',
    role: 'Rolle',
    yourPlan: 'Ihr Tarif',
    upgradePlan: 'Tarif upgraden',

    signIn: 'Anmelden',
    signUp: 'Registrieren',
    signingIn: 'Anmeldung läuft...',
    signingUp: 'Konto wird erstellt...',
    emailAddress: 'E-Mail-Adresse',
    password: 'Passwort',
    rememberMe: '30 Tage angemeldet bleiben',
    forgotPassword: 'Passwort vergessen?',
    continueWithGoogle: 'Mit Google fortfahren',
    orContinueWithEmail: 'oder mit E-Mail fortfahren',
    dontHaveAccount: 'Noch kein Konto?',
    alreadyHaveAccount: 'Sie haben bereits ein Konto?',
    createAccount: 'Konto erstellen',
    welcomeBack: 'Willkommen zurück',

    errPermission:
      'Ihr Konto darf keine Projekte erstellen. Diese Funktion ist nur für Fachexperten aktiviert — bitte wenden Sie sich an Ihren Administrator.',
    errSessionExpired: 'Ihre Sitzung ist abgelaufen. Bitte melden Sie sich erneut an.',
    errDuplicate: 'Ein Projekt mit diesem Namen existiert bereits. Bitte wählen Sie einen anderen Namen.',
    errInvalid: 'Einige Felder fehlen oder sind ungültig. Bitte überprüfen Sie die Eingaben.',
    errNotFound: 'Die angeforderte Ressource wurde nicht gefunden. Prüfen Sie ggf. den GitLab-Token und Zugriff.',
    errNetwork: 'Server konnte nicht erreicht werden. Bitte versuchen Sie es gleich noch einmal.',
    errGeneric: 'Etwas ist schiefgelaufen. Bitte erneut versuchen oder den Support kontaktieren.',
    errProjectCreate: 'Projekt konnte nicht erstellt werden. Bitte erneut versuchen.',

    dailyQuotaExceeded: 'Tageskontingent aufgebraucht.',
    resetsAtMidnight: 'Setzt sich um Mitternacht (UTC) zurück.',

    save: 'Speichern',
    cancel: 'Abbrechen',
    delete: 'Löschen',
    rename: 'Umbenennen',
    confirm: 'Bestätigen',
    close: 'Schließen',
    retry: 'Erneut versuchen',
    ok: 'OK',
  },
};

export type TranslationKey = keyof Dict;
