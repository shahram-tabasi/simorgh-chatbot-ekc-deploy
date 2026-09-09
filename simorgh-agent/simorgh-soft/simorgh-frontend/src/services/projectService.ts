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
  async getImport(projectId: number, scopeId: number, revisionId: number): Promise<any> {
    const r = await fetch(
      `${API_BASE_URL}/tpms/import?projectId=${projectId}&scopeId=${scopeId}&revisionId=${revisionId}`);
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
  width?: number;
  height?: number;
  pinX?: number;
  pinY?: number;
  /** How many cells down the line it should take (`data-cells`). */
  cells?: number;
  title?: string;
}

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
      return list.map((entry: any) =>
        (typeof entry === 'string' ? { name: entry } : entry)) as PackSymbol[];
    } catch {
      return [];
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
      throw new Error('Failed to create project');
    }
    return response.json();
  },

  // آپدیت پروژه
  async updateProject(id: string, projectData: Partial<ProjectData>): Promise<ProjectData> {
    const response = await fetch(`${API_BASE_URL}/projects/${id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(projectData),
    });
    
    if (!response.ok) {
      throw new Error('Failed to update project');
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
    return response.json();
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