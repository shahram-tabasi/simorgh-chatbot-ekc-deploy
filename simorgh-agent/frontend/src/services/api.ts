// src/services/apiService.ts
import { 
  ChatRequest, 
  ChatResponse, 
  Project, 
  Chat, 
  Message,
  ApiResponse 
} from '../types';

const API_BASE_URL = process.env.REACT_APP_API_URL || 'http://localhost:8000';

class ApiService {
  private async request<T>(
    endpoint: string, 
    options: RequestInit = {}
  ): Promise<ApiResponse<T>> {
    try {
      const response = await fetch(`${API_BASE_URL}${endpoint}`, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...options.headers,
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      return data;
    } catch (error) {
      console.error('API request failed:', error);
      throw error;
    }
  }

  // ============================================
  // Chat Operations
  // ============================================

  async sendMessage(
    content: string,
    options: {
      projectId?: string;
      chatId?: string;
      isGeneral?: boolean;
      files?: File[];
    }
  ): Promise<ChatResponse> {
    const formData = new FormData();
    formData.append('content', content);
    
    if (options.projectId) formData.append('projectId', options.projectId);
    if (options.chatId) formData.append('chatId', options.chatId);
    if (options.isGeneral) formData.append('isGeneral', 'true');
    
    options.files?.forEach(file => {
      formData.append('files', file);
    });

    const response = await fetch(`${API_BASE_URL}/api/chat/message`, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      throw new Error('Failed to send message');
    }

    return response.json();
  }

  // ============================================
  // Project Operations (MongoDB)
  // ============================================

  async createProject(data: {
    name: string;
    firstPageTitle: string;
  }): Promise<ApiResponse<Project>> {
    return this.request('/api/projects', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async getProjects(userId: string): Promise<ApiResponse<Project[]>> {
    return this.request(`/api/projects?userId=${userId}`);
  }

  async createProjectChat(data: {
    projectId: string;
    title: string;
  }): Promise<ApiResponse<Chat>> {
    return this.request('/api/projects/chats', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async getProjectChats(projectId: string): Promise<ApiResponse<Chat[]>> {
    return this.request(`/api/projects/${projectId}/chats`);
  }

  async getChatMessages(chatId: string): Promise<ApiResponse<Message[]>> {
    return this.request(`/api/chats/${chatId}/messages`);
  }

  // ============================================
  // General Chats (Redis)
  // ============================================

  async createGeneralChat(data: {
    userId: string;
    title: string;
  }): Promise<ApiResponse<Chat>> {
    return this.request('/api/general-chats', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async getGeneralChats(userId: string): Promise<ApiResponse<Chat[]>> {
    return this.request(`/api/general-chats?userId=${userId}`);
  }

  async saveGeneralChatMessage(data: {
    userId: string;
    chatId: string;
    message: Message;
  }): Promise<ApiResponse<void>> {
    return this.request('/api/general-chats/messages', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  // ============================================
  // File Upload
  // ============================================

  async uploadFile(file: File, projectId?: string): Promise<ApiResponse<{
    url: string;
    id: string;
    name: string;
  }>> {
    const formData = new FormData();
    formData.append('file', file);
    if (projectId) formData.append('projectId', projectId);

    const response = await fetch(`${API_BASE_URL}/api/upload`, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      throw new Error('Failed to upload file');
    }

    return response.json();
  }

  // ============================================
  // Document Analysis
  // ============================================

  async analyzeDocument(data: {
    file: File;
    projectId: string;
    oeNumber: string;
    thinkingLevel?: 'low' | 'medium' | 'high';
  }): Promise<ApiResponse<any>> {
    const formData = new FormData();
    formData.append('file', data.file);
    formData.append('projectId', data.projectId);
    formData.append('oeNumber', data.oeNumber);
    if (data.thinkingLevel) formData.append('thinkingLevel', data.thinkingLevel);

    const response = await fetch(`${API_BASE_URL}/api/analyze`, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      throw new Error('Failed to analyze document');
    }

    return response.json();
  }

  // ============================================
  // Search & Context
  // ============================================

  async search(query: string, projectId?: string): Promise<ApiResponse<any>> {
    const params = new URLSearchParams({ query });
    if (projectId) params.append('projectId', projectId);

    return this.request(`/api/search?${params.toString()}`);
  }
}

export const apiService = new ApiService();
export default apiService;