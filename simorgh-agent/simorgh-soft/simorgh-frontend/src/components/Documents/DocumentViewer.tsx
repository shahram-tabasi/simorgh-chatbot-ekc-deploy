import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import {
  XIcon, DownloadIcon, ChevronLeftIcon, ChevronRightIcon, MessageSquareIcon,
  TrashIcon, HighlighterIcon,
} from 'lucide-react';
import { DocumentComment, DocumentHighlight, ProjectDocument, documentsApi } from '../../services/documentsApi';

// Vite-idiomatic worker URL — resolved at build time, served alongside the
// bundle rather than fetched from a CDN (this app has no outside network
// access it can rely on, per the rest of the deploy story).
pdfjsLib.GlobalWorkerOptions.workerSrc =
  new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();

// Opens one uploaded document: renders it (PDF pages via PDF.js onto a
// canvas, images directly, everything else as a download-only notice), and
// carries comments and highlights on it. A highlight is a click-drag
// rectangle stored as percentages of the page/image box, so it survives a
// different zoom or window size without redoing the math; a comment is
// either general (about the document as a whole) or pinned to one
// highlight via highlightId. Every add saves immediately — there is no
// separate "Save" step to forget.

const HIGHLIGHT_COLOR = '#fbbf24'; // amber-400, ~40% opacity applied inline

interface Props {
  document: ProjectDocument;
  onClose: () => void;
  onChanged?: (doc: ProjectDocument) => void;
  currentUser?: string;
}

const isPdf = (mime: string) => mime === 'application/pdf';
const isImage = (mime: string) => mime.startsWith('image/');

export const DocumentViewer: React.FC<Props> = ({ document: doc, onClose, onChanged, currentUser }) => {
  const [comments, setComments] = useState<DocumentComment[]>(doc.comments || []);
  const [highlights, setHighlights] = useState<DocumentHighlight[]>(doc.highlights || []);
  const [page, setPage] = useState(1);
  const [numPages, setNumPages] = useState(1);
  const [newComment, setNewComment] = useState('');
  const [activeHighlightId, setActiveHighlightId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [draftComment, setDraftComment] = useState('');

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const pdfDocRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null);

  const fileUrl = documentsApi.fileUrl(doc._id);
  const author = currentUser || 'unknown';

  const persist = async (next: { comments?: DocumentComment[]; highlights?: DocumentHighlight[] }) => {
    try {
      await documentsApi.saveAnnotations(doc._id, next);
      const updated = { ...doc, comments: next.comments ?? comments, highlights: next.highlights ?? highlights };
      onChanged?.(updated);
    } catch (err) {
      alert(`Could not save: ${(err as Error).message}`);
    }
  };

  // ── PDF loading + page render ────────────────────────────────────────────
  useEffect(() => {
    if (!isPdf(doc.mimeType)) return;
    let cancelled = false;
    pdfjsLib.getDocument(fileUrl).promise.then(pdf => {
      if (cancelled) return;
      pdfDocRef.current = pdf;
      setNumPages(pdf.numPages);
    }).catch(err => console.error('PDF load failed:', err));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc._id]);

  useEffect(() => {
    if (!isPdf(doc.mimeType) || !pdfDocRef.current) return;
    let cancelled = false;
    pdfDocRef.current.getPage(page).then(async pageProxy => {
      if (cancelled) return;
      const viewport = pageProxy.getViewport({ scale: 1.4 });
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      await pageProxy.render({ canvasContext: ctx, viewport }).promise;
    }).catch(err => console.error('Page render failed:', err));
    return () => { cancelled = true; };
  }, [page, numPages, doc.mimeType]);

  // ── Drag-to-highlight, in percentages of the overlay box ────────────────
  const pct = (clientX: number, clientY: number) => {
    const box = overlayRef.current?.getBoundingClientRect();
    if (!box) return { x: 0, y: 0 };
    return {
      x: Math.min(100, Math.max(0, ((clientX - box.left) / box.width) * 100)),
      y: Math.min(100, Math.max(0, ((clientY - box.top) / box.height) * 100)),
    };
  };

  const onMouseDown = (e: React.MouseEvent) => {
    if (activeHighlightId) setActiveHighlightId(null);
    const p = pct(e.clientX, e.clientY);
    dragStart.current = p;
    setDraft({ x: p.x, y: p.y, w: 0, h: 0 });
  };
  const onMouseMove = (e: React.MouseEvent) => {
    if (!dragStart.current) return;
    const p = pct(e.clientX, e.clientY);
    const x = Math.min(dragStart.current.x, p.x);
    const y = Math.min(dragStart.current.y, p.y);
    setDraft({ x, y, w: Math.abs(p.x - dragStart.current.x), h: Math.abs(p.y - dragStart.current.y) });
  };
  const onMouseUp = () => {
    dragStart.current = null;
    // A click rather than a drag — too small to be a meaningful rectangle.
    if (draft && (draft.w < 1 || draft.h < 1)) setDraft(null);
  };

  const commitDraftHighlight = async () => {
    if (!draft) return;
    const highlight: DocumentHighlight = {
      id: `hl-${Date.now()}`,
      page: isPdf(doc.mimeType) ? page : undefined,
      xPct: draft.x, yPct: draft.y, wPct: draft.w, hPct: draft.h,
      color: HIGHLIGHT_COLOR,
      author,
      createdAt: new Date().toISOString(),
    };
    const nextHighlights = [...highlights, highlight];
    let nextComments = comments;
    if (draftComment.trim()) {
      nextComments = [...comments, {
        id: `c-${Date.now()}`,
        text: draftComment.trim(),
        author,
        createdAt: new Date().toISOString(),
        highlightId: highlight.id,
      }];
    }
    setHighlights(nextHighlights);
    setComments(nextComments);
    setDraft(null);
    setDraftComment('');
    await persist({ highlights: nextHighlights, comments: nextComments });
  };

  const deleteHighlight = async (id: string) => {
    const nextHighlights = highlights.filter(h => h.id !== id);
    const nextComments = comments.filter(c => c.highlightId !== id);
    setHighlights(nextHighlights);
    setComments(nextComments);
    if (activeHighlightId === id) setActiveHighlightId(null);
    await persist({ highlights: nextHighlights, comments: nextComments });
  };

  const addGeneralComment = async () => {
    if (!newComment.trim()) return;
    const nextComments = [...comments, {
      id: `c-${Date.now()}`,
      text: newComment.trim(),
      author,
      createdAt: new Date().toISOString(),
    }];
    setComments(nextComments);
    setNewComment('');
    await persist({ comments: nextComments });
  };

  const deleteComment = async (id: string) => {
    const nextComments = comments.filter(c => c.id !== id);
    setComments(nextComments);
    await persist({ comments: nextComments });
  };

  const visibleHighlights = useMemo(
    () => highlights.filter(h => !isPdf(doc.mimeType) || h.page === page),
    [highlights, page, doc.mimeType]);

  const canAnnotate = isPdf(doc.mimeType) || isImage(doc.mimeType);

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[210]" onClick={onClose}>
      <div
        className="bg-white rounded-lg shadow-2xl w-[1200px] max-w-[97vw] h-[90vh] flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div className="bg-slate-700 text-white px-5 py-3 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold truncate">{doc.filename}</h2>
            <p className="text-[11px] text-slate-200">{doc.category} · {(doc.size / 1024).toFixed(0)} KB · {doc.uploadedBy}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <a
              href={fileUrl} target="_blank" rel="noreferrer" download={doc.filename}
              className="flex items-center gap-1 px-2 py-1 text-xs rounded hover:bg-white/20"
              title="Download"
            >
              <DownloadIcon className="w-3.5 h-3.5" /> Download
            </a>
            <button onClick={onClose} className="p-1 rounded hover:bg-white/20" title="Close">
              <XIcon className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 flex min-h-0">
          {/* ── Viewer ── */}
          <div className="flex-1 overflow-auto bg-gray-100 p-4">
            {isPdf(doc.mimeType) && (
              <>
                <div className="flex items-center justify-center gap-3 mb-3 text-sm">
                  <button
                    className="p-1 rounded hover:bg-gray-200 disabled:opacity-30"
                    onClick={() => setPage(p => Math.max(1, p - 1))}
                    disabled={page <= 1}
                  ><ChevronLeftIcon className="w-4 h-4" /></button>
                  <span>Page {page} of {numPages}</span>
                  <button
                    className="p-1 rounded hover:bg-gray-200 disabled:opacity-30"
                    onClick={() => setPage(p => Math.min(numPages, p + 1))}
                    disabled={page >= numPages}
                  ><ChevronRightIcon className="w-4 h-4" /></button>
                  <span className="text-xs text-gray-400 flex items-center gap-1 ml-3">
                    <HighlighterIcon className="w-3.5 h-3.5" /> Drag on the page to highlight
                  </span>
                </div>
                <div className="flex justify-center">
                  <div ref={overlayRef} className="relative inline-block" onMouseDown={onMouseDown} onMouseMove={onMouseMove} onMouseUp={onMouseUp}>
                    <canvas ref={canvasRef} className="border border-gray-300 shadow bg-white" />
                    {visibleHighlights.map(h => (
                      <div
                        key={h.id}
                        onClick={e => { e.stopPropagation(); setActiveHighlightId(h.id); }}
                        style={{
                          position: 'absolute', left: `${h.xPct}%`, top: `${h.yPct}%`,
                          width: `${h.wPct}%`, height: `${h.hPct}%`,
                          background: h.color, opacity: activeHighlightId === h.id ? 0.55 : 0.35,
                          border: activeHighlightId === h.id ? '2px solid #d97706' : '1px solid #d97706',
                          cursor: 'pointer',
                        }}
                        title={comments.find(c => c.highlightId === h.id)?.text || 'Highlight'}
                      />
                    ))}
                    {draft && (
                      <div style={{
                        position: 'absolute', left: `${draft.x}%`, top: `${draft.y}%`,
                        width: `${draft.w}%`, height: `${draft.h}%`,
                        background: HIGHLIGHT_COLOR, opacity: 0.4, border: '1px dashed #d97706',
                        pointerEvents: 'none',
                      }} />
                    )}
                  </div>
                </div>
              </>
            )}

            {isImage(doc.mimeType) && (
              <div className="flex justify-center">
                <div ref={overlayRef} className="relative inline-block" onMouseDown={onMouseDown} onMouseMove={onMouseMove} onMouseUp={onMouseUp}>
                  <img src={fileUrl} alt={doc.filename} className="max-w-full border border-gray-300 shadow bg-white" draggable={false} />
                  {visibleHighlights.map(h => (
                    <div
                      key={h.id}
                      onClick={e => { e.stopPropagation(); setActiveHighlightId(h.id); }}
                      style={{
                        position: 'absolute', left: `${h.xPct}%`, top: `${h.yPct}%`,
                        width: `${h.wPct}%`, height: `${h.hPct}%`,
                        background: h.color, opacity: activeHighlightId === h.id ? 0.55 : 0.35,
                        border: activeHighlightId === h.id ? '2px solid #d97706' : '1px solid #d97706',
                        cursor: 'pointer',
                      }}
                      title={comments.find(c => c.highlightId === h.id)?.text || 'Highlight'}
                    />
                  ))}
                  {draft && (
                    <div style={{
                      position: 'absolute', left: `${draft.x}%`, top: `${draft.y}%`,
                      width: `${draft.w}%`, height: `${draft.h}%`,
                      background: HIGHLIGHT_COLOR, opacity: 0.4, border: '1px dashed #d97706',
                      pointerEvents: 'none',
                    }} />
                  )}
                </div>
              </div>
            )}

            {!canAnnotate && (
              <div className="flex flex-col items-center justify-center h-full text-center text-gray-500">
                <p className="text-sm mb-2">No inline preview for this file type.</p>
                <a href={fileUrl} target="_blank" rel="noreferrer" download={doc.filename} className="text-blue-600 hover:underline text-sm">
                  Download {doc.filename} to view it
                </a>
                <p className="text-xs text-gray-400 mt-4">Comments below still apply to the whole document.</p>
              </div>
            )}

            {draft && draft.w >= 1 && draft.h >= 1 && (
              <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-white border border-gray-300 rounded-lg shadow-2xl p-3 w-80 z-[220]">
                <p className="text-xs font-semibold text-gray-600 mb-1.5">Add a comment to this highlight (optional)</p>
                <textarea
                  autoFocus
                  rows={2}
                  className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
                  value={draftComment}
                  onChange={e => setDraftComment(e.target.value)}
                />
                <div className="flex justify-end gap-2 mt-2">
                  <button className="px-3 py-1 text-xs border rounded hover:bg-gray-50" onClick={() => { setDraft(null); setDraftComment(''); }}>Cancel</button>
                  <button className="px-3 py-1 text-xs bg-amber-600 text-white rounded hover:bg-amber-700" onClick={commitDraftHighlight}>Save highlight</button>
                </div>
              </div>
            )}
          </div>

          {/* ── Comments panel ── */}
          <div className="w-80 shrink-0 border-l flex flex-col min-h-0">
            <div className="px-4 py-3 border-b bg-gray-50 flex items-center gap-2">
              <MessageSquareIcon className="w-4 h-4 text-gray-500" />
              <span className="text-sm font-semibold text-gray-700">Comments ({comments.length})</span>
            </div>
            <div className="flex-1 overflow-y-auto divide-y">
              {comments.length === 0 && (
                <p className="p-4 text-xs text-gray-400">No comments yet.</p>
              )}
              {comments.map(c => (
                <div
                  key={c.id}
                  className={`p-3 text-xs ${c.highlightId && c.highlightId === activeHighlightId ? 'bg-amber-50' : ''}`}
                  onMouseEnter={() => c.highlightId && setActiveHighlightId(c.highlightId)}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium text-gray-700">{c.author}</p>
                      <p className="text-gray-400">{new Date(c.createdAt).toLocaleString()}</p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {c.highlightId && <HighlighterIcon className="w-3 h-3 text-amber-600" />}
                      <button title="Delete" className="text-gray-300 hover:text-red-600" onClick={() => deleteComment(c.id)}>
                        <TrashIcon className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                  <p className="mt-1 text-gray-800 whitespace-pre-wrap">{c.text}</p>
                  {c.highlightId && (
                    <button
                      className="mt-1 text-[10px] text-red-500 hover:underline"
                      onClick={() => deleteHighlight(c.highlightId!)}
                    >
                      remove highlight
                    </button>
                  )}
                </div>
              ))}
            </div>
            <div className="p-3 border-t">
              <textarea
                rows={2}
                placeholder="Add a general comment…"
                className="w-full border border-gray-300 rounded px-2 py-1.5 text-xs"
                value={newComment}
                onChange={e => setNewComment(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) addGeneralComment(); }}
              />
              <button
                className="mt-1.5 w-full px-3 py-1.5 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-40"
                onClick={addGeneralComment}
                disabled={!newComment.trim()}
              >
                Add comment
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
