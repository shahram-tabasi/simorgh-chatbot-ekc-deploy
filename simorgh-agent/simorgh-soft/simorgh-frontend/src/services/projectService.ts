import { ProjectData, Revision, RevisionCreateData } from '../types/project';

const API_BASE_URL = `${import.meta.env.VITE_API_URL || ''}/api`;

export const projectService = {
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
  // Revision API Methods
  // ==============================

  // Get all revisions for a project
  async getRevisions(projectId: string): Promise<Revision[]> {
    const response = await fetch(`${API_BASE_URL}/revisions/${projectId}`);
    if (!response.ok) {
      throw new Error('Failed to fetch revisions');
    }
    return response.json();
  },

  // Create a new revision (takes a snapshot of current project state)
  async createRevision(revisionData: RevisionCreateData): Promise<Revision> {
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

  // Get a specific revision
  async getRevision(revisionId: string): Promise<Revision> {
    const response = await fetch(`${API_BASE_URL}/revisions/detail/${revisionId}`);
    if (!response.ok) {
      throw new Error('Failed to fetch revision');
    }
    return response.json();
  },

  // Load project data from a revision (restore)
  async loadRevision(revisionId: string): Promise<ProjectData> {
    const response = await fetch(`${API_BASE_URL}/revisions/${revisionId}/load`);
    if (!response.ok) {
      throw new Error('Failed to load revision');
    }
    return response.json();
  },

  // Delete a revision (password protected)
  async deleteRevision(revisionId: string, password: string): Promise<void> {
    const response = await fetch(`${API_BASE_URL}/revisions/${revisionId}`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ password }),
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Failed to delete revision');
    }
  }
};