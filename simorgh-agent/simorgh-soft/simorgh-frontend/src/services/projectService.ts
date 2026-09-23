import { ProjectData, Revision, RevisionComparison } from '../types/project';

const API_BASE_URL = `${import.meta.env.VITE_API_URL || ''}/api`;

// ── TPMS (MySQL) — the same data Eplanix reads ──────────────────────────────
export interface TpmsOption {
  value: number;
  text: string;
  /** OE number, when the row carries one separately (the project list does). */
  code?: string;
  /** The plain name, without the OE number in front of it. */
  name?: string;
}

export const tpmsService = {
  async getProjects(): Promise<TpmsOption[]> {
    const r = await fetch(`${API_BASE_URL}/tpms/projects`);
    if (!r.ok) throw new Error('Could not read the TPMS project list');
    return (await r.json()).items ?? [];
  },

  async getScopes(projectId: number): Promise<TpmsOption[]> {
    const r = await fetch(`${API_BASE_URL}/tpms/scopes/${projectId}`);
    if (!r.ok) throw new Error('Could not read the switchgears for this project');
    return (await r.json()).items ?? [];
  },

  async getRevisions(scopeId: number): Promise<TpmsOption[]> {
    const r = await fetch(`${API_BASE_URL}/tpms/revisions/${scopeId}`);
    if (!r.ok) throw new Error('Could not read the revisions for this switchgear');
    return (await r.json()).items ?? [];
  },

  // Everything about a TPMS project except its feeder lines: the project
  // itself, its technical settings and every switchgear it holds.
  async getProjectHeader(projectMainId: number): Promise<any> {
    const r = await fetch(`${API_BASE_URL}/tpms/project/${projectMainId}`);
    const body = await r.json().catch(() => ({}));
    if (!r.ok || body.success === false) {
      throw new Error(body.error || 'Could not read this project from TPMS');
    }
    return body;
  },

  // The panel specification of one switchgear, on its own so that reading a
  // project never depends on one request that grows with its size.
  async getProjectPanel(projectMainId: number, scopeId: number): Promise<any> {
    const r = await fetch(`${API_BASE_URL}/tpms/project/${projectMainId}/panel/${scopeId}`);
    const body = await r.json().catch(() => ({}));
    if (!r.ok || body.success === false) {
      throw new Error(body.error || `Could not read the panel specification of switchgear ${scopeId}`);
    }
    return body;
  },

  // How big a project is in TPMS, and how long each read takes — what the
  // dialog's "Check this project" reports.
  async getProjectStats(projectMainId: number): Promise<any> {
    const r = await fetch(`${API_BASE_URL}/tpms/project/${projectMainId}/stats`);
    const body = await r.json().catch(() => ({}));
    if (!r.ok || body.success === false) {
      throw new Error(body.error || 'Could not read this project from TPMS');
    }
    return body;
  },

  // One revision of a TPMS project: the feeder lines of every switchgear in
  // it, or — with a scopeId — of that one switchgear. Heavy projects are read
  // switchgear by switchgear so no single request has to carry the lot.
  async getProjectRevision(projectMainId: number, revision: number, scopeId?: number): Promise<any> {
    const query = scopeId != null ? `?scopeId=${scopeId}` : '';
    const r = await fetch(`${API_BASE_URL}/tpms/project/${projectMainId}/revision/${revision}${query}`);
    const body = await r.json().catch(() => ({}));
    if (!r.ok || body.success === false) {
      throw new Error(body.error || `Could not read revision ${revision} from TPMS`);
    }
    return body;
  },

  // The whole switchgear: project, technical settings, panel specification,
  // every feeder line and the parts on it.
  /**
   * One switchgear out of TPMS. `revisionId` is optional: a panel TPMS holds
   * no revision for yet has a specification and no feeder lines, and that is a
   * project the engineer carries on with by hand rather than one they cannot
   * open.
   */
  async getImport(projectId: number, scopeId: number, revisionId?: number | null): Promise<any> {
    const rev = revisionId == null || !Number.isFinite(revisionId)
      ? '' : `&revisionId=${revisionId}`;
    const r = await fetch(
      `${API_BASE_URL}/tpms/import?projectId=${projectId}&scopeId=${scopeId}${rev}`);
    const body = await r.json().catch(() => ({}));
    if (!r.ok || body.success === false) {
      throw new Error(body.error || 'Could not read this switchgear from TPMS');
    }
    return body;
  },
};

// ── EPLAN symbols ───────────────────────────────────────────────────────────
// The single-line symbol each part carries in EPLAN's parts database, and the
// folder of symbols exported from EPLAN itself.
export interface EplanSymbol {
  symbol: string;
  library?: string;
  variant?: string;
  functionDefinition?: string;
  partNumber?: string;
  orderNumber?: string;
  /** Set when the symbol pack has an SVG for this symbol. */
  packUrl?: string;
}

/** One SVG in the symbol pack: its name, its own box, and where its conductor
 *  runs inside that box (`data-pin-x`), so the drawing can put the symbol on
 *  the branch line at the right size. */
export interface PackSymbol {
  name: string;
  /**
   * Which kind of file it came from.
   *
   * An SVG is a picture, and its box is read on the server out of the opening
   * tag. A DXF is geometry, read by the app itself — same reader the Simorgh
   * Draw tab uses — so its box, its conductor and its terminals come out of
   * the drawing rather than out of an attribute someone had to write. Older
   * servers report neither and everything they list is an SVG.
   */
  kind?: 'svg' | 'dxf';
  width?: number;
  height?: number;
  pinX?: number;
  pinY?: number;
  /** How many cells down the line it should take (`data-cells`). */
  cells?: number;
  title?: string;
}

// ── The office's own symbol library ─────────────────────────────────────────
// Kept on the server, not in the browser. A library an office builds up over
// years does not belong in a cache that clearing site data erases and that the
// draughtsman at the next desk cannot see.

export interface OfficeSymbol {
  /** What a drawing and the assistant name it by. Unique, never reassigned. */
  id: string;
  name: string;
  kind: 'sld' | 'wd' | 'old';
  group: string;
  /** Markup with no `<svg>` around it, like every other symbol source. */
  art: string;
  width: number;
  height: number;
  /**
   * Where a wire may land on it, what each point is called, and which way the
   * wire leaves it.
   *
   * `dir` is optional because every symbol saved before it existed has none,
   * and a library that will not open its own back catalogue is no library.
   */
  terminals: { x: number; y: number; name: string; dir?: string }[];
  /**
   * The symbol this one is a face of — its key in the library, not its name.
   *
   * A breaker's LSI, LSIG and LI are one device drawn three ways. Saying which
   * one a variant came from is what lets the library show the family together
   * and Tab turn between them while one hangs on the cursor. It is a plain
   * string rather than a live reference: the original may be deleted, and a
   * variant whose original is gone is still a symbol.
   */
  variantOf?: string;
  changedOn?: string;
}

export const symbolLibraryService = {
  /**
   * Everything the office has added.
   *
   * Never throws: the built-in libraries are on this machine, and a drawing
   * must still open when the server is unreachable. An empty list is the
   * honest answer to "what has the office added" when nobody can be asked.
   */
  async all(): Promise<OfficeSymbol[]> {
    try {
      const r = await fetch(`${API_BASE_URL}/symbols`);
      if (!r.ok) return [];
      return (await r.json()).symbols ?? [];
    } catch {
      return [];
    }
  },

  /** Adds or replaces one. Throws, because saving is something a user asked for. */
  async save(symbol: OfficeSymbol): Promise<OfficeSymbol> {
    const r = await fetch(`${API_BASE_URL}/symbols/${encodeURIComponent(symbol.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(symbol),
    });
    if (!r.ok) {
      const said = await r.json().catch(() => ({}));
      throw new Error(said.error || 'The symbol could not be saved');
    }
    return (await r.json()).symbol;
  },

  async remove(id: string): Promise<void> {
    const r = await fetch(`${API_BASE_URL}/symbols/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (!r.ok) throw new Error('The symbol could not be deleted');
  },

  /**
   * The whole library as a file.
   *
   * A file because it is the only transport these sites have — the servers are
   * off the internet, and a library moves between them the way a drawing does.
   * It is also what makes the library something the office owns rather than
   * something inside a server.
   */
  async exportAll(): Promise<LibraryFile> {
    const r = await fetch(`${API_BASE_URL}/library/export`);
    if (!r.ok) throw new Error('The library could not be exported');
    return r.json();
  },

  /** Read a library file back in. `merge` keeps what is here; `replace` does not. */
  async importAll(file: LibraryFile, mode: 'merge' | 'replace'): Promise<ImportResult> {
    const r = await fetch(`${API_BASE_URL}/library/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...file, mode }),
    });
    if (!r.ok) {
      const said = await r.json().catch(() => ({}));
      throw new Error(said.error || 'The library could not be imported');
    }
    return r.json();
  },
};

/** What an exported library file holds. */
export interface LibraryFile {
  format: string;
  version: number;
  exportedOn?: string;
  symbols: OfficeSymbol[];
}

export interface ImportResult {
  added: number;
  updated: number;
  skipped: number;
  replaced: boolean;
}

/** The only value `format` may take — anything else is not one of our files. */
export const LIBRARY_FORMAT = 'simorgh-draw-library';

// ── Simorgh Logic ───────────────────────────────────────────────────────────

export interface LadderRequest {
  /** What the program should do, in the engineer's own words. */
  task: string;
  /** This vendor's vocabulary, written out from the dialect table. */
  briefing: string;
  controller?: string;
  language?: string;
  /** 'teach' explains from further back; 'brief' assumes the reader knows. */
  style?: 'teach' | 'brief';
  /** What has already been asked and answered, so it is not asked again. */
  answers?: { ask: string; chose: string }[];
}

/** One option of a question the assistant came back with. */
export interface LadderOption {
  label: string;
  /** A line under it, where the choice needs one. */
  note?: string;
}

/**
 * A question the assistant asked rather than guessing at.
 *
 * Most of what makes a program right is not in the sentence it was given —
 * whether the stop is maintained, what happens on a fault, how many the
 * counter counts to. Guessing produces a program that looks finished and is
 * wrong in a place nobody can see, so the assistant is told to ask, and to ask
 * in options somebody can click rather than in prose somebody has to answer.
 */
export interface LadderQuestion {
  ask: string;
  /** Why it matters — what it changes about the program. */
  why?: string;
  options: LadderOption[];
  /** True where more than one option may be picked. */
  multi?: boolean;
}

export interface LadderAnswer {
  success: boolean;
  /** The program as it arrived — validated in the browser, not here. */
  program?: unknown;
  /** Asked instead of answered. Never both: a model that asks and then answers
   *  has guessed, and the guess is what asking was meant to avoid. */
  questions?: LadderQuestion[];
  model?: string;
  error?: string;
  /** What the model said when it did not answer with a program. */
  raw?: string;
}

export const ladderService = {
  /**
   * Ask the model for a program.
   *
   * Never throws: a refusal is an answer, and the panel shows the model's own
   * words rather than a dead end. Only a network failure comes back as one of
   * these, and it says so.
   */
  async generate(request: LadderRequest): Promise<LadderAnswer> {
    try {
      const r = await fetch(`${API_BASE_URL}/ladder/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
      const said = await r.json().catch(() => ({}));
      if (!r.ok) {
        return {
          success: false,
          error: said.error || `The assistant answered ${r.status}.`,
          raw: said.raw,
          model: said.model,
        };
      }
      return said as LadderAnswer;
    } catch (err) {
      // The browser's own words here are "Failed to fetch", which says nothing
      // to the person reading it and looks like the app broke. It means the
      // request never came back: the model is busy, or the gateway in front of
      // it timed out. Both are worth waiting out, and neither costs the
      // drawing — so say that, and keep the raw text for whoever wants it.
      return {
        success: false,
        error: 'The assistant could not be reached — the request came back with no answer. '
          + 'The model may be busy or out of reach. Wait a moment and ask again; '
          + 'nothing already drawn is lost.',
        raw: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

/**
 * Asking the model to work on the PLC program.
 *
 * The same shape as `ladderService` and for the same reason: a refusal is an
 * answer and belongs on screen in the model's own words, so this never throws
 * except where the request never came back at all.
 *
 * What makes it different from the ladder one is the snapshot. The program as
 * it is now goes with every request — the blocks, the tags, the instruction
 * vocabulary and what the checker says is wrong — because a model that cannot
 * see the project names tags that nearly exist, and "nearly" is what costs an
 * hour.
 */
export interface PlcRequest {
  task: string;
  /** The program written down — see `utils/plc/aiContext.ts`. */
  snapshot: string;
  /** The instruction catalogue, where the task needs it. */
  vocabulary?: string;
  language?: string;
  style?: 'teach' | 'brief';
  answers?: { ask: string; chose: string }[];
}

export interface PlcAnswer {
  success: boolean;
  /** Blocks and tags as they arrived — validated in the browser, not here. */
  generated?: unknown;
  questions?: LadderQuestion[];
  model?: string;
  error?: string;
  raw?: string;
}

export const plcService = {
  async generate(request: PlcRequest): Promise<PlcAnswer> {
    try {
      const r = await fetch(`${API_BASE_URL}/plc/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
      const said = await r.json().catch(() => ({}));
      if (!r.ok) {
        return {
          success: false,
          error: said.error || `The assistant answered ${r.status}.`,
          raw: said.raw,
          model: said.model,
        };
      }
      return said as PlcAnswer;
    } catch (err) {
      return {
        success: false,
        error: 'The assistant could not be reached — the request came back with no answer. '
          + 'The model may be busy or out of reach. Wait a moment and ask again; nothing '
          + 'already written is lost.',
        raw: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

export const eplanSymbolService = {
  async schema(): Promise<any> {
    const r = await fetch(`${API_BASE_URL}/eplan-symbols/schema`);
    if (!r.ok) throw new Error('Could not read the EPLAN symbol schema');
    return r.json();
  },

  // Never throws: a project must still draw when EPLAN is out of reach.
  async lookup(parts: string[]): Promise<Record<string, EplanSymbol>> {
    if (parts.length === 0) return {};
    try {
      const r = await fetch(`${API_BASE_URL}/eplan-symbols/lookup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parts }),
      });
      if (!r.ok) return {};
      return (await r.json()).symbols ?? {};
    } catch {
      return {};
    }
  },

  async pack(): Promise<PackSymbol[]> {
    try {
      const r = await fetch(`${API_BASE_URL}/eplan-symbols/pack`);
      if (!r.ok) return [];
      const list = (await r.json()).symbols ?? [];
      // A name on its own is all older packs reported; the size and the pin
      // come with it now.
      return list.map((entry: any) => (typeof entry === 'string'
        ? { name: entry, kind: 'svg' as const }
        : { kind: 'svg' as const, ...entry })) as PackSymbol[];
    } catch {
      return [];
    }
  },

  /** A pack DXF's text. Never throws: a symbol out of reach falls back to the
   *  library's own drawing of that device. */
  async dxf(name: string): Promise<string | null> {
    try {
      const r = await fetch(`${API_BASE_URL}/eplan-symbols/dxf/${encodeURIComponent(name)}`);
      if (!r.ok) return null;
      const text = await r.text();
      return text.trim() ? text : null;
    } catch {
      return null;
    }
  },

  /**
   * Put a symbol in the pack, so everyone who opens a project draws with it.
   *
   * Copying the file onto the server does the same thing and still works; this
   * is for an office that has the drawing but not a shell on that machine. It
   * only ever writes — a symbol is taken out by deleting the file, by someone
   * who can see the folder.
   */
  async upload(name: string, kind: 'svg' | 'dxf', content: string): Promise<
    { ok: true; replaced: boolean } | { ok: false; error: string }
  > {
    try {
      const r = await fetch(`${API_BASE_URL}/eplan-symbols/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, kind, content }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || !body?.success) {
        return { ok: false, error: body?.error || `The server refused it (${r.status}).` };
      }
      return { ok: true, replaced: Boolean(body.replaced) };
    } catch {
      return { ok: false, error: 'The server could not be reached.' };
    }
  },

  // Absolute, because the printable window is opened on about:blank and a
  // relative URL there has nothing to resolve against.
  svgUrl(name: string): string {
    const base = API_BASE_URL.startsWith('/')
      ? `${window.location.origin}${API_BASE_URL}`
      : API_BASE_URL;
    return `${base}/eplan-symbols/svg/${encodeURIComponent(name)}`;
  },
};

export interface DesktopInstallerInfo {
  available: boolean;
  fileName?: string;
  size?: number;
  modified?: string;
  version?: string;
}

/**
 * Somebody else saved this project while this copy was open.
 *
 * Carries their version, so the app can show what the choice is between
 * rather than only that there is one.
 */
export class ProjectConflict extends Error {
  readonly theirs: ProjectData;
  readonly theirRev: number;
  constructor(message: string, theirs: ProjectData, theirRev: number) {
    super(message || 'This project was changed on another computer');
    this.name = 'ProjectConflict';
    this.theirs = theirs;
    this.theirRev = theirRev;
  }
}

/**
 * A save that will fail again, however many times it is tried.
 *
 * Two projects with one name, a project too large for a document, a request
 * the server will not take: these are not "the server is down for a minute",
 * they are "somebody has to change something". Retrying them on a timer is
 * noise in the log, load on the server, and — worst — a dialog that says it is
 * still trying when trying is not what will fix it.
 *
 * The autosave stops its loop when it sees one of these. The warning stays up,
 * because the work is still not saved, and Try now still works, because the
 * person may have fixed it.
 */
export class SaveNeedsYou extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'SaveNeedsYou';
    this.status = status;
  }
}

/** One switchgear as a kept version remembers it. */
export interface VersionSwitchgear {
  id: string;
  name: string;
  type: string;
  rows: number;
}

/** A version of a project the server kept before replacing it. */
export interface ProjectVersion {
  _id: string;
  projectId: string;
  projectName: string;
  rev: number | null;
  /** When this version was replaced. */
  savedAt: string;
  /** When it had last been edited. */
  changedOn: string | null;
  reason: string;
  plainSize: number;
  counts: {
    templates: number;
    equipments: number;
    rows: number;
    switchgears: VersionSwitchgear[];
  };
}

export const projectService = {
  // The Windows desktop installer published on the server, if there is one.
  // Never throws — a missing endpoint or an empty folder simply means the
  // download link stays hidden.
  async getDesktopInstaller(): Promise<DesktopInstallerInfo> {
    try {
      const response = await fetch(`${API_BASE_URL}/desktop/latest`);
      if (!response.ok) return { available: false };
      return await response.json();
    } catch {
      return { available: false };
    }
  },

  desktopDownloadUrl(): string {
    return `${API_BASE_URL}/desktop/download`;
  },

  // دریافت تمام پروژه‌ها
  async getAllProjects(): Promise<ProjectData[]> {
    const response = await fetch(`${API_BASE_URL}/projects`);
    if (!response.ok) {
      throw new Error('Failed to fetch projects');
    }
    return response.json();
  },

  // جستجوی پروژه‌ها
  async searchProjects(query: string): Promise<ProjectData[]> {
    const response = await fetch(`${API_BASE_URL}/projects/search?q=${encodeURIComponent(query)}`);
    if (!response.ok) {
      throw new Error('Failed to search projects');
    }
    return response.json();
  },

  // دریافت پروژه بر اساس ID
  async getProjectById(id: string): Promise<ProjectData> {
    const response = await fetch(`${API_BASE_URL}/projects/${id}`);
    if (!response.ok) {
      throw new Error('Failed to fetch project');
    }
    return response.json();
  },

  // دریافت پروژه بر اساس نام
  async getProjectByName(projectName: string): Promise<ProjectData | null> {
    const response = await fetch(`${API_BASE_URL}/projects/name/${encodeURIComponent(projectName)}`);
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error('Failed to fetch project by name');
    }
    return response.json();
  },

  // ایجاد پروژه جدید
  /**
   * Why a request failed, in the server's own words.
   *
   * "Failed to update project" is true of every failure and useful for none.
   * A project too big for one MongoDB document, a database that is down, a
   * proxy refusing the size — all three read the same, and the one person who
   * could act on the difference is the one being told.
   */
  async _reason(response: Response, fallback: string): Promise<string> {
    let detail = '';
    try {
      const body = await response.clone().json();
      detail = (body as { error?: string; message?: string })?.error
        || (body as { message?: string })?.message || '';
    } catch {
      try { detail = (await response.text()).slice(0, 200); } catch { /* nothing to read */ }
    }
    return `${fallback} (HTTP ${response.status})${detail ? `: ${detail}` : ''}`;
  },

  /** The versions of a project the server has kept, newest first. */
  async listProjectHistory(id: string): Promise<ProjectVersion[]> {
    const response = await fetch(`${API_BASE_URL}/projects/${id}/history`);
    if (!response.ok) throw new Error(await this._reason(response, 'Failed to read the history'));
    return response.json();
  },

  /** One kept version, whole, as the project was at that moment. */
  async readProjectVersion(id: string, versionId: string): Promise<ProjectData> {
    const response = await fetch(`${API_BASE_URL}/projects/${id}/history/${versionId}`);
    if (!response.ok) throw new Error(await this._reason(response, 'Failed to read that version'));
    return response.json();
  },

  async createProject(projectData: Omit<ProjectData, '_id'>): Promise<ProjectData> {
    const response = await fetch(`${API_BASE_URL}/projects`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(projectData),
    });
    
    if (response.status === 409) {
      throw new Error('Project with this name already exists');
    }
    
    if (!response.ok) {
      throw new Error(await this._reason(response, 'Failed to create the project'));
    }
    return response.json();
  },

  // آپدیت پروژه
  /**
   * Save a project over the version it was started from.
   *
   * `baseRev` is the version this copy last read or wrote. The server only
   * writes over a document still on that version — so when somebody else has
   * saved in the meantime the write does not land, and what comes back is
   * their version rather than a silent overwrite of one of the two.
   *
   * Left out, the write is unconditional. That is for an older client; this
   * app always sends it.
   */
  async updateProject(
    id: string, projectData: Partial<ProjectData>, baseRev?: number,
  ): Promise<ProjectData> {
    const response = await fetch(`${API_BASE_URL}/projects/${id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(baseRev === undefined ? projectData : { ...projectData, baseRev }),
    });

    if (response.status === 409) {
      const body = await response.json().catch(() => ({}));
      if (body?.conflict) throw new ProjectConflict(body.error, body.project, body.currentRev);
      // A name clash is not going to clear itself: somebody has to rename
      // something. Retrying it every fifteen seconds was ten attempts deep
      // and counting when this was reported.
      throw new SaveNeedsYou(
        body?.error || 'Another project already has that name', 409);
    }
    if (!response.ok) {
      const reason = await this._reason(response, 'Failed to save the project');
      // Anything the server refuses outright — a bad request, a payload it
      // will not take — is the same kind of thing. A 5xx is not: that really
      // can be a minute of trouble, and retrying is right.
      if (response.status >= 400 && response.status < 500) {
        throw new SaveNeedsYou(reason, response.status);
      }
      throw new Error(reason);
    }
    return response.json();
  },

  // حذف پروژه
  async deleteProject(id: string): Promise<void> {
    const response = await fetch(`${API_BASE_URL}/projects/${id}`, {
      method: 'DELETE',
    });
    
    if (!response.ok) {
      throw new Error('Failed to delete project');
    }
  },

  // بررسی سلامت سرور
  async healthCheck(): Promise<any> {
    const response = await fetch(`${API_BASE_URL}/health`);
    if (!response.ok) {
      throw new Error('Server health check failed');
    }
    return response.json();
  },

  // ==============================
  // Revision Management APIs
  // ==============================

  // Get all revisions for a project
  async getRevisions(projectId: string): Promise<Revision[]> {
    const response = await fetch(`${API_BASE_URL}/projects/${projectId}/revisions`);
    if (!response.ok) {
      throw new Error('Failed to fetch revisions');
    }
    // Latest first, numerically. Everything that decides whether a revision
    // may be edited reads the first of this list as the latest, and a string
    // sort puts REV 9 ahead of REV 13 — so it is sorted here as well, whatever
    // order the server sends.
    const list: Revision[] = await response.json();
    return [...list].sort((a, b) =>
      (parseInt(b.revisionNumber, 10) || 0) - (parseInt(a.revisionNumber, 10) || 0));
  },

  // Get a specific revision
  async getRevision(revisionId: string): Promise<Revision> {
    const response = await fetch(`${API_BASE_URL}/revisions/${revisionId}`);
    if (!response.ok) {
      throw new Error('Failed to fetch revision');
    }
    return response.json();
  },

  // Create a new revision
  async createRevision(revisionData: Omit<Revision, '_id' | 'createdOn' | 'changedOn'>): Promise<Revision> {
    const response = await fetch(`${API_BASE_URL}/revisions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(revisionData),
    });
    
    if (!response.ok) {
      throw new Error('Failed to create revision');
    }
    return response.json();
  },

  // Update a revision
  async updateRevision(revisionId: string, revisionData: Partial<Revision>): Promise<Revision> {
    const response = await fetch(`${API_BASE_URL}/revisions/${revisionId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(revisionData),
    });
    
    if (!response.ok) {
      throw new Error('Failed to update revision');
    }
    return response.json();
  },

  // Delete a revision (requires the revision-delete password, see
  // REVISION_DELETE_PASSWORD in server/server.js)
  async deleteRevision(revisionId: string, password: string): Promise<void> {
    const response = await fetch(`${API_BASE_URL}/revisions/${revisionId}`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ password }),
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || 'Failed to delete revision');
    }
  },

  // Compare two revisions
  async compareRevisions(baseRevisionId: string, targetRevisionId: string): Promise<RevisionComparison> {
    const response = await fetch(
      `${API_BASE_URL}/revisions/compare?base=${baseRevisionId}&target=${targetRevisionId}`
    );
    if (!response.ok) {
      throw new Error('Failed to compare revisions');
    }
    return response.json();
  },

  // Export comparison report (PDF or Excel)
  async exportComparisonReport(
    baseRevisionId: string,
    targetRevisionId: string,
    format: 'pdf' | 'excel'
  ): Promise<Blob> {
    const response = await fetch(
      `${API_BASE_URL}/revisions/compare/export?base=${baseRevisionId}&target=${targetRevisionId}&format=${format}`,
      {
        method: 'GET',
        headers: {
          'Content-Type': `application/${format === 'pdf' ? 'pdf' : 'vnd.openxmlformats-officedocument.spreadsheetml.sheet'}`,
        },
      }
    );
    
    if (!response.ok) {
      throw new Error('Failed to export comparison report');
    }
    return response.blob();
  }
};