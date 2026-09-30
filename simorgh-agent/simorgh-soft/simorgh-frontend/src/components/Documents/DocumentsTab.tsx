import React, { useEffect, useRef, useState } from 'react';
import {
  UploadIcon, FileTextIcon, ImageIcon, FileSpreadsheetIcon, FileIcon,
  TrashIcon, MessageSquareIcon, HighlighterIcon, RefreshCwIcon,
} from 'lucide-react';
import { useProject } from '../../context/ProjectContext';
import {
  DOCUMENT_CATEGORIES, DocumentCategory, ProjectDocument, documentsApi,
} from '../../services/documentsApi';
import { DocumentViewer } from './DocumentViewer';
import { appConfirm } from '../shared/AppDialog';

// The Documents tab: every file this project needs, filed under one of the
// categories the office already uses (SPEC, SLD-OLD, Site Layout, Logic,
// Load List, Io List, Data sheet, Cover, Other). Files live in the backend
// (Mongo GridFS) rather than the project's own JSON, so they don't inflate
// every save/load of the project — and so the chatbot can read them without
// anyone re-uploading per conversation (list_project_documents /
// read_project_document in chatbotTools.ts read the same store).

const iconFor = (mimeType: string) => {
  if (mimeType === 'application/pdf') return FileTextIcon;
  if (mimeType.startsWith('image/')) return ImageIcon;
  if (mimeType.includes('spreadsheet') || mimeType.includes('excel')) return FileSpreadsheetIcon;
  return FileIcon;
};

const formatSize = (bytes: number) => bytes > 1024 * 1024
  ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  : `${Math.max(1, Math.round(bytes / 1024))} KB`;

export const DocumentsTab: React.FC = () => {
  const { projectData } = useProject();
  const projectId = projectData._id;

  const [category, setCategory] = useState<DocumentCategory>('SPEC');
  const [documents, setDocuments] = useState<ProjectDocument[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<ProjectDocument | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = () => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    documentsApi.list(projectId)
      .then(setDocuments)
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  };

  useEffect(load, [projectId]);

  if (!projectId) {
    return (
      <div className="p-8 text-center text-gray-500">
        <p className="text-sm">Save the project first — documents are filed against the saved project.</p>
      </div>
    );
  }

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    setError(null);
    try {
      for (const file of Array.from(files)) {
        await documentsApi.upload(projectId, category, file, projectData.planner);
      }
      load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleDelete = async (doc: ProjectDocument, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!await appConfirm(`Delete "${doc.filename}"? This cannot be undone.`, { danger: true, confirmLabel: 'Delete' })) return;
    try {
      await documentsApi.remove(doc._id);
      setDocuments(prev => prev.filter(d => d._id !== doc._id));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const countByCategory = (c: DocumentCategory) => documents.filter(d => d.category === c).length;
  const shown = documents.filter(d => d.category === category);

  return (
    <div className="flex gap-4 h-full">
      {/* ── Categories ── */}
      <div className="w-52 shrink-0 border border-gray-200 rounded-lg overflow-hidden">
        <div className="px-3 py-2 bg-gray-50 border-b text-xs font-semibold text-gray-600">
          Categories
        </div>
        {DOCUMENT_CATEGORIES.map(c => (
          <button
            key={c}
            onClick={() => setCategory(c)}
            className={`w-full flex items-center justify-between px-3 py-2 text-sm text-left border-b last:border-b-0 ${
              category === c ? 'bg-blue-50 text-blue-700 font-medium' : 'text-gray-700 hover:bg-gray-50'
            }`}
          >
            <span>{c}</span>
            <span className="text-xs text-gray-400">{countByCategory(c)}</span>
          </button>
        ))}
      </div>

      {/* ── File list ── */}
      <div className="flex-1 border border-gray-200 rounded-lg overflow-hidden flex flex-col">
        <div className="px-4 py-3 bg-gray-50 border-b flex items-center justify-between gap-3">
          <div>
            <h3 className="font-semibold text-gray-800">{category}</h3>
            <p className="text-xs text-gray-500">{shown.length} file{shown.length === 1 ? '' : 's'}</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={load}
              className="p-2 text-gray-500 hover:bg-gray-100 rounded"
              title="Refresh"
            >
              <RefreshCwIcon className="w-4 h-4" />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg,.gif,.webp"
              className="hidden"
              onChange={e => handleFiles(e.target.files)}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="flex items-center gap-2 px-3 py-1.5 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50"
            >
              <UploadIcon className="w-4 h-4" />
              {uploading ? 'Uploading…' : `Upload to ${category}`}
            </button>
          </div>
        </div>

        {error && (
          <div className="px-4 py-2 bg-red-50 text-red-700 text-xs border-b">{error}</div>
        )}

        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <p className="p-6 text-sm text-gray-400">Loading…</p>
          ) : shown.length === 0 ? (
            <p className="p-6 text-sm text-gray-400">Nothing uploaded to {category} yet.</p>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {shown.map(doc => {
                  const Icon = iconFor(doc.mimeType);
                  return (
                    <tr
                      key={doc._id}
                      className="border-b hover:bg-gray-50 cursor-pointer"
                      onClick={() => setViewing(doc)}
                    >
                      <td className="px-4 py-2.5 w-8"><Icon className="w-4 h-4 text-gray-400" /></td>
                      <td className="px-2 py-2.5">
                        <p className="font-medium text-gray-800 truncate max-w-[320px]">{doc.filename}</p>
                        <p className="text-xs text-gray-500">
                          {formatSize(doc.size)} · {doc.uploadedBy} · {new Date(doc.uploadedAt).toLocaleDateString()}
                        </p>
                      </td>
                      <td className="px-2 py-2.5 text-xs text-gray-500 whitespace-nowrap">
                        {doc.comments.length > 0 && (
                          <span className="inline-flex items-center gap-1 mr-3">
                            <MessageSquareIcon className="w-3.5 h-3.5" /> {doc.comments.length}
                          </span>
                        )}
                        {doc.highlights.length > 0 && (
                          <span className="inline-flex items-center gap-1">
                            <HighlighterIcon className="w-3.5 h-3.5" /> {doc.highlights.length}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 w-8 text-right">
                        <button
                          title="Delete"
                          className="text-gray-300 hover:text-red-600"
                          onClick={e => handleDelete(doc, e)}
                        >
                          <TrashIcon className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {viewing && (
        <DocumentViewer
          document={viewing}
          currentUser={projectData.planner}
          onClose={() => setViewing(null)}
          onChanged={updated => {
            setViewing(updated);
            setDocuments(prev => prev.map(d => d._id === updated._id ? updated : d));
          }}
        />
      )}
    </div>
  );
};

export default DocumentsTab;
