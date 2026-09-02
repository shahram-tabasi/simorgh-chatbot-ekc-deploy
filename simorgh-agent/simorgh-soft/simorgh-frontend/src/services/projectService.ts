import { ProjectData, Revision, RevisionComparison } from '../types/project';

const API_BASE_URL = `${import.meta.env.VITE_API_URL || ''}/api`;

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