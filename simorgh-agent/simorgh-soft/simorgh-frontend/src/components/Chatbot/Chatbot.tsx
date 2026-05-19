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
  MessageSquareIcon, XIcon, SendIcon, PaperclipIcon, Trash2Icon,
  ImageIcon, FileTextIcon, FileSpreadsheetIcon, FileIcon, Loader2Icon,
  MaximizeIcon, MinimizeIcon, BotIcon, UserIcon,
} from 'lucide-react';

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
  error?: boolean;
  pending?: boolean;
}

// Default endpoints. The local one points at the same backend host the
// frontend is served from; the online one defaults to /api/chat-online
// (override via VITE_CHATBOT_LOCAL_URL / VITE_CHATBOT_ONLINE_URL at build).
const env: any = (import.meta as any).env || {};
const LOCAL_DEFAULT  = env.VITE_CHATBOT_LOCAL_URL  || '/api/chat-local';
const ONLINE_DEFAULT = env.VITE_CHATBOT_ONLINE_URL || '/api/chat-online';

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
      text: 'سلام! من دستیار طراحی سیمرغ هستم. می‌توانی متن بنویسی یا فایل (عکس، PDF، Excel) بفرستی. حالت پیش‌فرض «لوکال» است؛ از تنظیمات می‌توانی «آنلاین» را انتخاب کنی.',
    },
  ]);
  const [busy, setBusy] = useState(false);

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
      text: 'گفتگو پاک شد. می‌توانی پرسش جدید بپرسی.',
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
      const fd = new FormData();
      fd.append('prompt', text);
      fd.append('mode', mode);
      filesToSend.forEach(a => fd.append('files', a.file, a.file.name));

      const res = await fetch(endpoint, { method: 'POST', body: fd });
      let reply = '';
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('application/json')) {
        const j = await res.json();
        reply = j.reply ?? j.message ?? j.error ?? JSON.stringify(j);
      } else {
        reply = await res.text();
      }
      if (!res.ok) throw new Error(reply || `HTTP ${res.status}`);

      setMessages(prev => prev.map(m =>
        m.id === pendingId ? { ...m, text: reply, pending: false } : m
      ));
    } catch (err: any) {
      const msg = err?.message || String(err);
      setMessages(prev => prev.map(m =>
        m.id === pendingId
          ? { ...m, text: `❌ ${msg}\n\nبررسی کن endpoint روی «${endpoint}» در دسترس است.`, error: true, pending: false }
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
      <div className="w-12 bg-gray-100 border-l border-gray-300 flex flex-col items-center pt-3 flex-shrink-0">
        <button
          onClick={() => setOpen(true)}
          title="Open AI Assistant"
          className="w-9 h-9 rounded-full bg-blue-600 hover:bg-blue-700 text-white shadow flex items-center justify-center transition-transform hover:scale-105"
        >
          <MessageSquareIcon className="w-4 h-4" />
        </button>
        <span className="mt-2 text-[10px] text-gray-500 [writing-mode:vertical-rl] rotate-180 tracking-wide">
          AI Assistant
        </span>
      </div>
    );
  }

  // ── Open: embedded as a flex column. Maximized → overlay full viewport.
  const panelClass = maximized
    ? 'fixed inset-4 z-50'
    : 'w-[420px] flex-shrink-0 border-l border-gray-300';

  return (
    <div className={`${panelClass} bg-white shadow-md flex flex-col overflow-hidden`}>
      {/* Title bar */}
      <div className="bg-blue-600 text-white px-4 py-2 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-2">
          <BotIcon className="w-4 h-4" />
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
              {m.role === 'user' ? <UserIcon className="w-3.5 h-3.5" /> : <BotIcon className="w-3.5 h-3.5" />}
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
          placeholder="یک پرسش بنویس… (Ctrl/Cmd + Enter to send)"
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
