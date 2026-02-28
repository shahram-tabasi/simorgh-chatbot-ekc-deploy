import { ProjectData } from '../types/project';

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
  }
};