// src/services/documentsApi.ts
//
// The Documents tab's backend — files live in MongoDB GridFS behind the
// simorgh-backend routes in documents.js. This is a thin client: list,
// fetch one, upload, save annotations, delete, and the raw-file URL the
// viewer points <embed>/<img> tags at directly.

const API_BASE_URL = `${import.meta.env.VITE_API_URL || ''}/api`;

export const DOCUMENT_CATEGORIES = [
  'SPEC', 'SLD-OLD', 'Site Layout', 'Logic', 'Load List', 'Io List',
  'Data sheet', 'Cover', 'Other',
] as const;
export type DocumentCategory = typeof DOCUMENT_CATEGORIES[number];

export interface DocumentComment {
  id: string;
  text: string;
  author: string;
  createdAt: string;
  /** Which highlight this comment belongs to, when it's not a general remark. */
  highlightId?: string;
}

export interface DocumentHighlight {
  id: string;
  /** 1-based; absent for file types with no page concept (images). */
  page?: number;
  /** Percentage-based (0-100), independent of zoom/render size. */
  xPct: number;
  yPct: number;
  wPct: number;
  hPct: number;
  color: string;
  author: string;
  createdAt: string;
}

export interface ProjectDocument {
  _id: string;
  projectId: string;
  category: DocumentCategory;
  filename: string;
  mimeType: string;
  size: number;
  uploadedBy: string;
  uploadedAt: string;
  gridfsId: string;
  /** Only present on the single-document GET, not the list. */
  extractedText?: string;
  comments: DocumentComment[];
  highlights: DocumentHighlight[];
}

async function asJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((body as any).error || `Request failed (${response.status})`);
  return body as T;
}

export const documentsApi = {
  async list(projectId: string): Promise<ProjectDocument[]> {
    const r = await fetch(`${API_BASE_URL}/documents?projectId=${encodeURIComponent(projectId)}`);
    return (await asJson<{ documents: ProjectDocument[] }>(r)).documents;
  },

  async get(id: string): Promise<ProjectDocument> {
    const r = await fetch(`${API_BASE_URL}/documents/${id}`);
    return asJson<ProjectDocument>(r);
  },

  async upload(projectId: string, category: DocumentCategory, file: File, uploadedBy?: string): Promise<ProjectDocument> {
    const form = new FormData();
    form.append('projectId', projectId);
    form.append('category', category);
    if (uploadedBy) form.append('uploadedBy', uploadedBy);
    form.append('file', file);
    const r = await fetch(`${API_BASE_URL}/documents/upload`, { method: 'POST', body: form });
    return asJson<ProjectDocument>(r);
  },

  async saveAnnotations(id: string, data: { comments?: DocumentComment[]; highlights?: DocumentHighlight[] }): Promise<void> {
    const r = await fetch(`${API_BASE_URL}/documents/${id}/annotations`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    await asJson(r);
  },

  async remove(id: string): Promise<void> {
    const r = await fetch(`${API_BASE_URL}/documents/${id}`, { method: 'DELETE' });
    await asJson(r);
  },

  /** Absolute, because the PDF.js worker and <img>/<embed> tags fetch this
   *  on their own, outside of React's fetch base. */
  fileUrl(id: string): string {
    const base = API_BASE_URL.startsWith('/') ? `${window.location.origin}${API_BASE_URL}` : API_BASE_URL;
    return `${base}/documents/${id}/file`;
  },
};
