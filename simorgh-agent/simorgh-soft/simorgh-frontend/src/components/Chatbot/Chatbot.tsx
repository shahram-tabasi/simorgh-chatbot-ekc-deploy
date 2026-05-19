// Simorgh AI Chatbot — VS Code style floating side panel.
//
// Lightweight chat UI that can talk to either a LOCAL endpoint (e.g. a
// locally running model server) or an ONLINE endpoint (configurable). The
// user picks between Local / Online from a dropdown. Files (images, PDFs,
// Excel, etc.) can be attached and are sent as multipart/form-data along
// with the prompt.
//
// The backend wiring is intentionally generic — any HTTP endpoint that
// accepts `prompt` (text) and optional `files[]` (multipart) and returns
// `{ reply: string }` will work. If the call fails, the error message is
// rendered inline so users see what went wrong.

import React, { useEffect, useRef, useState } from 'react';
import {
  SparklesIcon, XIcon, SendIcon, PaperclipIcon, Trash2Icon,
  ImageIcon, FileTextIcon, FileSpreadsheetIcon, FileIcon, Loader2Icon,
  MaximizeIcon, MinimizeIcon, UserIcon, ZapIcon,
} from 'lucide-react';
import * as XLSX from 'xlsx';
import { useProject } from '../../context/ProjectContext';
import {
  chatToolSchemas, executeChatToolBatch, ChatToolCall, ChatToolResult,
} from '../../services/chatbotTools';

type Mode = 'local' | 'online';

interface Attachment {
  id: string;
  file: File;
  previewUrl?: string;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  attachments?: { name: string; type: string; size: number }[];
  /** Per-tool outcomes (executed locally against the project). */
  toolResults?: { tool: string; summary: string; ok: boolean }[];
  error?: boolean;
  pending?: boolean;
}

/** Parse an AI reply that may contain a JSON envelope with tool_calls.
 *  Accepts either:
 *    1. A raw JSON object  `{ "reply": "...", "tool_calls": [...] }`
 *    2. A fenced ```json ... ``` block in an otherwise-text reply
 *    3. Plain text (no tools)
 */
function parseToolEnvelope(raw: string): { reply: string; tool_calls: ChatToolCall[] } {
  const tryJson = (s: string) => {
    try {
      const obj = JSON.parse(s);
      if (obj && typeof obj === 'object' && Array.isArray(obj.tool_calls)) {
        return {
          reply: typeof obj.reply === 'string' ? obj.reply : '',
          tool_calls: obj.tool_calls as ChatToolCall[],
        };
      }
    } catch { /* not JSON */ }
    return null;
  };
  const direct = tryJson(raw.trim());
  if (direct) return direct;

  const fence = raw.match(/```json\s*([\s\S]+?)```/i);
  if (fence) {
    const parsed = tryJson(fence[1].trim());
    if (parsed) {
      const stripped = raw.replace(fence[0], '').trim();
      return { reply: parsed.reply || stripped, tool_calls: parsed.tool_calls };
    }
  }
  return { reply: raw, tool_calls: [] };
}

// Default endpoints. The app is served under a base path (e.g.
// /simorgh-design-suite/) and the container nginx maps `<base>/api/*` to the
// Node backend. Resolving against `import.meta.env.BASE_URL` keeps the chat
// requests inside the simorgh-soft container — otherwise a bare `/api/...`
// gets caught by the host-level nginx and routed to the wrong backend.
const env: any = (import.meta as any).env || {};
const BASE = (env.BASE_URL || '/').replace(/\/+$/, '/');
const LOCAL_DEFAULT  = env.VITE_CHATBOT_LOCAL_URL  || `${BASE}api/chat-local`;
const ONLINE_DEFAULT = env.VITE_CHATBOT_ONLINE_URL || `${BASE}api/chat-online`;

const ACCEPTED_TYPES = '.png,.jpg,.jpeg,.gif,.webp,.svg,.pdf,.xls,.xlsx,.csv,.txt,.md,.json,.docx,.doc';

function iconForFile(type: string) {
  if (type.startsWith('image/')) return <ImageIcon className="w-3.5 h-3.5" />;
  if (type === 'application/pdf') return <FileTextIcon className="w-3.5 h-3.5" />;
  if (type.includes('sheet') || type.includes('excel') || type.includes('csv'))
    return <FileSpreadsheetIcon className="w-3.5 h-3.5" />;
  return <FileIcon className="w-3.5 h-3.5" />;
}

function formatBytes(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

export const Chatbot: React.FC = () => {
  const [open, setOpen]               = useState(false);
  const [maximized, setMaximized]     = useState(false);
  const [mode, setMode]               = useState<Mode>('local');
  const [endpoint, setEndpoint]       = useState<string>(LOCAL_DEFAULT);
  const [endpointDraft, setEndpointDraft] = useState<string>(LOCAL_DEFAULT);
  const [showSettings, setShowSettings] = useState(false);
  const [prompt, setPrompt]           = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [messages, setMessages]       = useState<ChatMessage[]>([
    {
      id: 'welcome',
      role: 'assistant',
      text:
        "Hi — I'm the Simorgh design assistant.\n" +
        '• Ask a question or give an instruction (e.g. "in the active equipment, change every row where wiringType is M3 to M4" or "set row 3 feederNo to L03").\n' +
        '• Toggle the Agent switch on to let me act on the project, off to keep it text-only.\n' +
        '• Attach files (image / PDF / Excel) — Excel sheets are parsed and forwarded as structured rows.',
    },
  ]);
  const [busy, setBusy] = useState(false);

  // Expose our column width via a CSS custom property so other components
  // (e.g. the Device Selection fullscreen overlay) can leave room for the
  // chatbot instead of covering it. Closed=48px, Open=420px, Maximized=0px
  // (the chatbot is a floating overlay in that case and z-orders above).
  useEffect(() => {
    const w = !open ? '48px' : (maximized ? '0px' : '420px');
    document.documentElement.style.setProperty('--simorgh-chat-w', w);
    return () => {
      document.documentElement.style.removeProperty('--simorgh-chat-w');
    };
  }, [open, maximized]);
  // Agent mode = the assistant is allowed to call frontend tools that mutate
  // project state (update rows, set colours, create templates, …). When off,
  // the chatbot only displays text replies and ignores any tool_calls.
  const [agentMode, setAgentMode] = useState<boolean>(true);

  const {
    projectData, selectedEquipment, updateEquipment, updateProjectData,
  } = useProject();

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const scrollRef    = useRef<HTMLDivElement | null>(null);

  // Switch endpoint default when mode changes (unless user already edited it).
  useEffect(() => {
    const defaultForMode = mode === 'local' ? LOCAL_DEFAULT : ONLINE_DEFAULT;
    setEndpoint(defaultForMode);
    setEndpointDraft(defaultForMode);
  }, [mode]);

  // Auto-scroll on new messages.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, busy]);

  const handleFilesPicked = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const next: Attachment[] = [];
    Array.from(files).forEach(file => {
      const att: Attachment = { id: `${Date.now()}-${file.name}`, file };
      if (file.type.startsWith('image/')) {
        att.previewUrl = URL.createObjectURL(file);
      }
      next.push(att);
    });
    setAttachments(prev => [...prev, ...next]);
  };

  const removeAttachment = (id: string) => {
    setAttachments(prev => {
      const target = prev.find(a => a.id === id);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter(a => a.id !== id);
    });
  };

  const clearChat = () => {
    attachments.forEach(a => a.previewUrl && URL.revokeObjectURL(a.previewUrl));
    setAttachments([]);
    setMessages([{
      id: 'welcome',
      role: 'assistant',
      text: 'Conversation cleared. Ask anything to get started.',
    }]);
  };

  const sendMessage = async () => {
    const text = prompt.trim();
    if (!text && attachments.length === 0) return;
    if (busy) return;

    const userMsg: ChatMessage = {
      id: `u-${Date.now()}`,
      role: 'user',
      text: text || '(without text)',
      attachments: attachments.map(a => ({
        name: a.file.name, type: a.file.type || 'unknown', size: a.file.size,
      })),
    };
    const pendingId = `a-${Date.now()}`;
    const pendingMsg: ChatMessage = {
      id: pendingId, role: 'assistant', text: '…', pending: true,
    };
    setMessages(prev => [...prev, userMsg, pendingMsg]);

    const filesToSend = attachments;
    setPrompt('');
    setAttachments([]);
    setBusy(true);

    try {
      // Pre-parse any attached Excel files into JSON so the AI can reference
      // them by name and use the `apply_excel` tool against the active table.
      const excelPreviews: { name: string; rows: any[] }[] = [];
      for (const a of filesToSend) {
        const ext = (a.file.name.split('.').pop() || '').toLowerCase();
        if (ext === 'xlsx' || ext === 'xls' || ext === 'csv') {
          try {
            const buf = await a.file.arrayBuffer();
            const wb = XLSX.read(new Uint8Array(buf), { type: 'array' });
            const sheet = wb.Sheets[wb.SheetNames[0]];
            const rows  = XLSX.utils.sheet_to_json<Record<string, any>>(sheet, { defval: '', raw: false });
            excelPreviews.push({ name: a.file.name, rows });
          } catch { /* ignore parse errors */ }
        }
      }

      const fd = new FormData();
      fd.append('prompt', text);
      fd.append('mode', mode);
      // Send a compact snapshot of the project so the LLM has context.
      const ctxSnapshot = {
        projectName: projectData.projectName,
        activeEquipment: selectedEquipment ? {
          id: selectedEquipment.id, name: selectedEquipment.name,
          type: selectedEquipment.type, rowCount: selectedEquipment.devices?.length ?? 0,
        } : null,
        equipments: (projectData.equipments ?? []).map(e => ({
          id: e.id, name: e.name, type: e.type, rows: e.devices?.length ?? 0,
        })),
        templateCounts: {
          LV: projectData.templates?.LV?.length ?? 0,
          MV: projectData.templates?.MV?.length ?? 0,
          HV: projectData.templates?.HV?.length ?? 0,
        },
      };
      fd.append('context', JSON.stringify(ctxSnapshot));
      if (agentMode) fd.append('tools', JSON.stringify(chatToolSchemas()));
      if (excelPreviews.length > 0) fd.append('excelPreviews', JSON.stringify(excelPreviews));
      filesToSend.forEach(a => fd.append('files', a.file, a.file.name));

      const res = await fetch(endpoint, { method: 'POST', body: fd });
      let raw = '';
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('application/json')) {
        const j = await res.json();
        // If the backend already returned a {reply, tool_calls} shape, keep it
        // as-is by re-stringifying so parseToolEnvelope handles it uniformly.
        if (j && (Array.isArray(j.tool_calls) || typeof j.reply === 'string')) {
          raw = JSON.stringify(j);
        } else {
          raw = j.message ?? j.error ?? JSON.stringify(j);
        }
      } else {
        raw = await res.text();
      }
      if (!res.ok) throw new Error(raw || `HTTP ${res.status}`);

      const { reply, tool_calls } = parseToolEnvelope(raw);
      const callsToRun = agentMode ? tool_calls : [];

      // Run any tools the assistant asked for.
      let toolResults: ChatToolResult[] = [];
      if (callsToRun.length > 0) {
        toolResults = await executeChatToolBatch(callsToRun, {
          projectData, selectedEquipment, updateEquipment, updateProjectData,
        });
      }

      setMessages(prev => prev.map(m =>
        m.id === pendingId ? {
          ...m,
          text: reply || (callsToRun.length > 0
            ? `Executed ${callsToRun.length} action(s).`
            : '(empty reply)'),
          toolResults: toolResults.map((r, i) => ({
            tool: callsToRun[i]?.name || '?',
            summary: r.summary,
            ok: r.ok,
          })),
          pending: false,
        } : m
      ));
    } catch (err: any) {
      const msg = err?.message || String(err);
      setMessages(prev => prev.map(m =>
        m.id === pendingId
          ? { ...m, text: `❌ ${msg}\n\nCheck the endpoint at "${endpoint}" is reachable from the browser.`, error: true, pending: false }
          : m
      ));
    } finally {
      setBusy(false);
      filesToSend.forEach(a => a.previewUrl && URL.revokeObjectURL(a.previewUrl));
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      sendMessage();
    }
  };

  // ── Closed: slim activity-bar column with a launcher button ─────────────
  // The chatbot is embedded as part of the main application layout (a flex
  // sibling), not a floating overlay. When closed it collapses to a narrow
  // 48px sidebar so the main content owns the rest of the width.
  if (!open) {
    return (
      // `relative z-50` keeps the column visible above any fullscreen modal
      // mounted elsewhere in the app (Device Selection fullscreen leaves
      // room for us via --simorgh-chat-w but is itself `fixed`).
      <div className="relative z-50 w-12 bg-gradient-to-b from-indigo-50 to-purple-50 border-l border-indigo-200 flex flex-col items-center pt-3 flex-shrink-0">
        <button
          onClick={() => setOpen(true)}
          title="Open Simorgh AI Assistant"
          className="w-10 h-10 rounded-full bg-gradient-to-br from-indigo-500 via-purple-500 to-pink-500 hover:from-indigo-600 hover:via-purple-600 hover:to-pink-600 text-white shadow-lg flex items-center justify-center transition-transform hover:scale-110 ring-2 ring-white"
        >
          <SparklesIcon className="w-5 h-5" />
        </button>
        <span className="mt-3 text-[10px] font-semibold text-indigo-700 [writing-mode:vertical-rl] rotate-180 tracking-widest">
          SIMORGH&nbsp;AI
        </span>
      </div>
    );
  }

  // ── Open: embedded as a flex column. Maximized → overlay full viewport.
  // `relative z-50` again so the column floats above any fixed fullscreen
  // overlay coming from sibling tabs.
  const panelClass = maximized
    ? 'fixed inset-4 z-50'
    : 'relative z-50 w-[420px] flex-shrink-0 border-l border-gray-300';

  return (
    <div className={`${panelClass} bg-white shadow-md flex flex-col overflow-hidden`}>
      {/* Title bar */}
      <div className="bg-gradient-to-r from-indigo-600 via-purple-600 to-pink-600 text-white px-4 py-2 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-2">
          <SparklesIcon className="w-4 h-4" />
          <span className="text-sm font-semibold">Simorgh AI Assistant</span>
          <span className="text-[10px] bg-blue-800 px-2 py-0.5 rounded-full uppercase">
            {mode}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            title={maximized ? 'Restore' : 'Maximize'}
            onClick={() => setMaximized(m => !m)}
            className="p-1.5 rounded hover:bg-blue-700"
          >
            {maximized ? <MinimizeIcon className="w-4 h-4" /> : <MaximizeIcon className="w-4 h-4" />}
          </button>
          <button
            title="Close"
            onClick={() => setOpen(false)}
            className="p-1.5 rounded hover:bg-blue-700"
          >
            <XIcon className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Toolbar */}
      <div className="border-b border-gray-200 px-3 py-2 flex items-center gap-2 flex-shrink-0 bg-gray-50">
        <label className="text-xs text-gray-600">Source:</label>
        <select
          value={mode}
          onChange={e => setMode(e.target.value as Mode)}
          className="text-xs border border-gray-300 rounded px-2 py-1 bg-white"
        >
          <option value="local">Local model</option>
          <option value="online">Online model</option>
        </select>
        <button
          className="text-xs text-blue-600 hover:underline"
          onClick={() => setShowSettings(s => !s)}
        >
          {showSettings ? 'Hide settings' : 'Endpoint…'}
        </button>
        <label className="ml-2 inline-flex items-center gap-1 text-xs text-gray-600" title="Allow the assistant to take actions on the project (edit rows, set colours, create templates).">
          <input
            type="checkbox"
            checked={agentMode}
            onChange={e => setAgentMode(e.target.checked)}
            className="accent-blue-600"
          />
          Agent
        </label>
        <button
          className="ml-auto text-xs text-red-600 hover:underline flex items-center gap-1"
          onClick={clearChat}
          title="Clear conversation"
        >
          <Trash2Icon className="w-3 h-3" /> Clear
        </button>
      </div>

      {showSettings && (
        <div className="bg-amber-50 border-b border-amber-200 px-3 py-2 flex items-center gap-2 flex-shrink-0">
          <span className="text-[10px] font-semibold text-amber-800">Endpoint:</span>
          <input
            type="text"
            value={endpointDraft}
            onChange={e => setEndpointDraft(e.target.value)}
            className="flex-1 text-xs border border-amber-200 rounded px-2 py-1 bg-white font-mono"
            placeholder="/api/chat-local"
          />
          <button
            className="text-xs bg-amber-600 text-white px-2 py-1 rounded hover:bg-amber-700"
            onClick={() => setEndpoint(endpointDraft.trim() || (mode === 'local' ? LOCAL_DEFAULT : ONLINE_DEFAULT))}
          >
            Apply
          </button>
        </div>
      )}

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-3 bg-gray-50">
        {messages.map(m => (
          <div
            key={m.id}
            className={`flex gap-2 ${m.role === 'user' ? 'flex-row-reverse' : ''}`}
          >
            <div className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 ${
              m.role === 'user' ? 'bg-blue-100 text-blue-700' : 'bg-gray-200 text-gray-700'
            }`}>
              {m.role === 'user' ? <UserIcon className="w-3.5 h-3.5" /> : <SparklesIcon className="w-3.5 h-3.5" />}
            </div>
            <div className={`max-w-[80%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap break-words ${
              m.role === 'user'
                ? 'bg-blue-600 text-white'
                : m.error
                  ? 'bg-red-50 text-red-800 border border-red-200'
                  : 'bg-white text-gray-800 border border-gray-200'
            }`}>
              {m.pending ? (
                <span className="inline-flex items-center gap-2 text-gray-500">
                  <Loader2Icon className="w-3.5 h-3.5 animate-spin" />
                  thinking…
                </span>
              ) : (
                <>
                  <div>{m.text}</div>
                  {m.toolResults && m.toolResults.length > 0 && (
                    <div className="mt-2 space-y-1 border-t border-gray-200/40 pt-1.5">
                      {m.toolResults.map((tr, i) => (
                        <div
                          key={i}
                          className={`text-[10px] px-2 py-1 rounded flex items-start gap-1.5 ${
                            tr.ok ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-700'
                          }`}
                        >
                          <ZapIcon className="w-3 h-3 mt-0.5 flex-shrink-0" />
                          <div>
                            <span className="font-mono font-semibold">{tr.tool}</span>
                            <span className="ml-1">{tr.summary}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {m.attachments && m.attachments.length > 0 && (
                    <div className={`mt-1.5 flex flex-wrap gap-1.5 ${m.role === 'user' ? 'text-blue-100' : 'text-gray-500'}`}>
                      {m.attachments.map((a, i) => (
                        <span key={i} className="inline-flex items-center gap-1 text-[10px] bg-black/10 px-1.5 py-0.5 rounded">
                          {iconForFile(a.type)}
                          {a.name} <span className="opacity-70">({formatBytes(a.size)})</span>
                        </span>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Attachment chips */}
      {attachments.length > 0 && (
        <div className="border-t border-gray-200 px-3 py-2 flex flex-wrap gap-2 flex-shrink-0 bg-white">
          {attachments.map(a => (
            <div key={a.id} className="flex items-center gap-1.5 bg-gray-100 border border-gray-200 rounded pl-1 pr-1.5 py-1 text-xs">
              {a.previewUrl ? (
                <img src={a.previewUrl} alt={a.file.name} className="w-6 h-6 object-cover rounded" />
              ) : (
                <span className="w-6 h-6 flex items-center justify-center bg-white border rounded">
                  {iconForFile(a.file.type)}
                </span>
              )}
              <span className="max-w-[140px] truncate">{a.file.name}</span>
              <span className="text-gray-400">{formatBytes(a.file.size)}</span>
              <button
                onClick={() => removeAttachment(a.id)}
                className="text-gray-400 hover:text-red-600"
                title="Remove"
              >
                <XIcon className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Composer */}
      <div className="border-t border-gray-200 px-3 py-2 flex items-end gap-2 flex-shrink-0 bg-white">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={ACCEPTED_TYPES}
          className="hidden"
          onChange={e => { handleFilesPicked(e.target.files); if (fileInputRef.current) fileInputRef.current.value = ''; }}
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          className="p-2 text-gray-500 hover:text-blue-600 hover:bg-blue-50 rounded"
          title="Attach files (image, PDF, Excel, …)"
          disabled={busy}
        >
          <PaperclipIcon className="w-4 h-4" />
        </button>
        <textarea
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask Simorgh AI… (Ctrl/Cmd + Enter to send)"
          rows={2}
          className="flex-1 text-sm border border-gray-300 rounded px-2 py-1.5 resize-none focus:outline-none focus:border-blue-400"
          disabled={busy}
        />
        <button
          onClick={sendMessage}
          disabled={busy || (!prompt.trim() && attachments.length === 0)}
          className="p-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
          title="Send (Ctrl/Cmd + Enter)"
        >
          {busy ? <Loader2Icon className="w-4 h-4 animate-spin" /> : <SendIcon className="w-4 h-4" />}
        </button>
      </div>
    </div>
  );
};

export default Chatbot;
