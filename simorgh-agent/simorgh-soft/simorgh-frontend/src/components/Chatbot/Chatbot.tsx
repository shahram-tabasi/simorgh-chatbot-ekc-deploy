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
  XIcon, SendIcon, PaperclipIcon, Trash2Icon,
  ImageIcon, FileTextIcon, FileSpreadsheetIcon, FileIcon, Loader2Icon,
  MaximizeIcon, MinimizeIcon, MinusIcon, UserIcon, ZapIcon,
} from 'lucide-react';
import { usePanel } from '../../context/PanelsContext';
import logoMark from '../../assets/logo-mark.png';

/**
 * The suite's own bird, wherever the assistant needs a face.
 *
 * It used to be a generic sparkle. The assistant is part of this product, not a
 * bolt-on, and it should look like it — the same mark the splash screen and the
 * header wear.
 */
const SimorghMark: React.FC<{ className?: string; white?: boolean }> = ({
  className = 'w-5 h-5', white = false,
}) => (
  // `white` for the mark on a coloured ground. The bird is drawn in navy, and
  // navy on the indigo-to-pink gradient of the launcher and the header is a
  // shape somebody has to go looking for — which is the opposite of what a
  // mark is for.
  <img
    src={logoMark}
    alt=""
    aria-hidden
    className={`${className} object-contain select-none${white ? ' brightness-0 invert' : ''}`}
  />
);
import * as XLSX from 'xlsx-js-style';
import { useProject } from '../../context/ProjectContext';
import {
  chatToolSchemas, executeChatToolBatch, ChatToolCall, ChatToolResult,
  ChatToolContext, ProposedAction, isMutatingTool, describeToolCall,
} from '../../services/chatbotTools';
import { intentParseAll } from '../../services/intentParser';
import { MarkdownView } from './MarkdownView';
import { ProposalCard } from './ProposalCard';

// Tab labels used both in the context snapshot we send to the model and in
// the local tool runner that resolves `set_active_tab`.
const TAB_LABELS = ['Project Definition', 'Create Template', 'Device Selection', 'Output Types', 'Simorgh Draw'] as const;

// What each tab owns, in the words the model is given. Sent with every turn
// so an unqualified instruction ("set the temperature to 50") is read against
// the screen the user is actually looking at.
const TAB_SCOPE: Record<number, string> = {
  0: 'Project Definition — project master data (name, client, standard, planner…), '
   + 'Technical Settings (altitude, design temperature, wire sizes, wire colours, painting) '
   + 'and the Device Library (panel specifications). Tools: set_project_fields, set_tech_setting, '
   + 'add_library_device, update_library_device, delete_library_device.',
  1: 'Create Template — the template tree and the parts on each template. '
   + 'Tools: create_template, search_templates, find_similar_templates, delete_template, '
   + 'set_template_property_parts.',
  2: 'Device Selection — the switchgears and their feeder rows. '
   + 'Tools: add_equipment, delete_equipment, select_equipment, add_row, update_row, '
   + 'bulk_update, delete_row, apply_excel, set_cell_color, set_row_color.',
  3: 'Output Types — the export formats. No editing tools; answer questions.',
  4: 'Simorgh Draw — single line, panel layout, mechanical items, CAD export and Send to EPLAN. '
   + 'Read-only here; the data comes from the other tabs.',
};

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
  /** Pending proposals — rendered as an interactive card with Apply/Reject. */
  proposals?: { title: string; actions: ProposedAction[] }[];
  /** Extracted text from any documents attached on this turn (PDF/Excel).
   *  Carried in history so subsequent turns can still reference the file
   *  without the user having to re-upload it. */
  extractedDocs?: { name: string; text: string }[];
  error?: boolean;
  pending?: boolean;
}

/** Strip reasoning tags some local models emit (gpt-oss-20b uses <think>).
 *  Defence-in-depth: the backend also strips, but if a different transport
 *  surfaces raw text we want the frontend parser to cope on its own. */
function stripReasoning(s: string): string {
  if (!s) return '';
  const patterns = [
    /<think>[\s\S]*?<\/think>/gi,
    /<thinking>[\s\S]*?<\/thinking>/gi,
    /<reasoning>[\s\S]*?<\/reasoning>/gi,
    /<analysis>[\s\S]*?<\/analysis>/gi,
    /<plan>[\s\S]*?<\/plan>/gi,
    /<scratchpad>[\s\S]*?<\/scratchpad>/gi,
  ];
  let out = s;
  for (const p of patterns) out = out.replace(p, '');
  // Trim an unterminated leading <think> if the model ran out of tokens.
  out = out.replace(/<think>[\s\S]*$/i, '');
  return out.trim();
}

/** Parse an AI reply that may contain a JSON envelope with tool_calls.
 *  Accepts:
 *    1. A raw JSON object  `{ "reply": "...", "tool_calls": [...] }`
 *    2. A fenced ```json ... ``` block in an otherwise-text reply
 *    3. The first balanced `{…}` substring (model preceded JSON with prose)
 *    4. Plain text → reply only, no tools
 */
function parseToolEnvelope(raw: string): { reply: string; tool_calls: ChatToolCall[] } {
  raw = stripReasoning(raw);
  const tryJson = (s: string) => {
    try {
      const obj = JSON.parse(s);
      if (obj && typeof obj === 'object') {
        return {
          reply: typeof obj.reply === 'string' ? obj.reply : '',
          tool_calls: Array.isArray(obj.tool_calls) ? (obj.tool_calls as ChatToolCall[]) : [],
        };
      }
    } catch { /* not JSON */ }
    return null;
  };
  const direct = tryJson(raw.trim());
  if (direct) return direct;

  const fence = raw.match(/```(?:json)?\s*([\s\S]+?)```/i);
  if (fence) {
    const parsed = tryJson(fence[1].trim());
    if (parsed) return parsed;
  }

  // First balanced {…} substring (in case the model wrapped JSON in prose).
  const start = raw.indexOf('{');
  if (start >= 0) {
    let depth = 0;
    for (let i = start; i < raw.length; i++) {
      if (raw[i] === '{') depth++;
      else if (raw[i] === '}') {
        depth--;
        if (depth === 0) {
          const parsed = tryJson(raw.slice(start, i + 1));
          if (parsed) return parsed;
          break;
        }
      }
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

interface ChatbotProps {
  /** Current top-level tab index, so the snapshot the AI receives includes
   *  what the user is looking at right now. */
  activeTab?: number;
  /** Setter so `set_active_tab` can route through the same React state. */
  setActiveTab?: (idx: number) => void;
}

export const Chatbot: React.FC<ChatbotProps> = ({ activeTab, setActiveTab }) => {
  const [open, setOpen]               = useState(false);
  // Closing the rail is different from collapsing the panel: collapsed leaves
  // the 48px launcher, closed takes the column off the screen altogether and
  // gives its width back to the workspace. It comes back from View → Panels,
  // which is where EPLAN keeps its navigators too.
  const panel = usePanel({
    id: 'simorgh-ai',
    label: 'Simorgh AI',
    group: 'Assistant',
    note: 'The assistant column down the right-hand side',
  });
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
        "## Hi — I'm Simorgh AI ✨\n\n" +
        "I work on **the tab you are on**: ask for a change and I read it against that screen — " +
        "on Project Definition `دما` is the design temperature, on Device Selection it is the rows.\n\n" +
        "**Nothing lands until you approve it.** With **Review** on (the default) every change I propose " +
        "appears as a checklist with an **Apply** button, so an engineer signs it off.\n\n" +
        "Some things to try:\n\n" +
        "**📄 Upload a project PDF** — I read it, extract project metadata, technical settings, equipment & devices, and show you a preview card. Pick which items to keep and hit **Apply** to fill the project.\n\n" +
        "**Project Definition**\n" +
        "- `Set project name to Pars Refinery, client NIORDC, standard IEC`\n" +
        "- `Altitude is 1200 m and design temperature is 45 °C`\n" +
        "- `دمای طراحی 50 درجه شود`\n\n" +
        "**Create Template**\n" +
        "- `Make a new LV template at S8 / OFW / FCB1 / OUTGOING for a 22 kW motor`\n" +
        "- `Search templates that contain FCB1`\n\n" +
        "**Device Selection**\n" +
        "- `Add a new LV equipment called MCC-01`\n" +
        "- `Set row 3 feederNo to L03`\n" +
        "- `Everywhere wiringType is M3, change it to M4`\n" +
        "- `Highlight row 2 red`\n" +
        "- Attach an Excel and say `Apply this Excel, map Wiring → wiringType`\n\n" +
        "Switch **Agent** off to keep replies text-only.",
    },
  ]);
  const [busy, setBusy] = useState(false);

  // Expose our column width via a CSS custom property so other components
  // (e.g. the Device Selection fullscreen overlay) can leave room for the
  // chatbot instead of covering it. Put away=0px, Collapsed=48px, Open=420px,
  // Maximized=0px (the chatbot is a floating overlay then and z-orders above).
  //
  // The put-away case matters: this effect runs whether or not the component
  // renders anything, so without it a closed assistant would still reserve
  // 48px of a fullscreen overlay for a column that is not on the screen.
  useEffect(() => {
    const w = !panel.open ? '0px' : !open ? '48px' : (maximized ? '0px' : '420px');
    document.documentElement.style.setProperty('--simorgh-chat-w', w);
    return () => {
      document.documentElement.style.removeProperty('--simorgh-chat-w');
    };
  }, [panel.open, open, maximized]);
  // Agent mode = the assistant is allowed to call frontend tools that mutate
  // project state (update rows, set colours, create templates, …). When off,
  // the chatbot only displays text replies and ignores any tool_calls.
  const [agentMode, setAgentMode] = useState<boolean>(true);
  // Review mode = nothing the assistant decides is written into the project
  // until an engineer has read it and pressed Apply. On by default: this is
  // design data, and the model is a proposer, not an approver.
  const [reviewMode, setReviewMode] = useState<boolean>(true);
  // Which model actually answered the last turn, as the backend reports it.
  const [modelNote, setModelNote] = useState<string>('');

  const {
    projectData, selectedEquipment, updateEquipment, updateProjectData,
    patchProjectData, addEquipment, deleteEquipment, setSelectedEquipment,
    deleteTemplate, saveProject,
  } = useProject();

  // One place that builds the handle set the tools run against, so the chat
  // turn and the Apply button can never drift apart.
  const toolContext = (): ChatToolContext => ({
    projectData, selectedEquipment, updateEquipment, updateProjectData,
    patchProjectData, addEquipment, deleteEquipment, setSelectedEquipment,
    deleteTemplate, setActiveTab, saveProject, activeTab,
  });

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

      // Send the last N messages as conversation history so the model has
      // continuity across turns (otherwise every prompt is one-shot and
      // the AI forgets that the user attached a PDF two turns ago). We
      // strip pending/error messages, drop the welcome, and re-include the
      // extracted text from any PDFs the user attached in earlier turns.
      const MAX_HISTORY = 10;
      const history = messages
        .filter(m => m.id !== 'welcome' && !m.pending && !m.error)
        .slice(-MAX_HISTORY)
        .map(m => {
          let body = m.text || '';
          if (m.extractedDocs && m.extractedDocs.length > 0) {
            body += '\n\n── Document text from this turn ──\n' +
              m.extractedDocs.map(d => `📄 ${d.name}:\n<<<\n${d.text}\n>>>`).join('\n\n');
          }
          return { role: m.role, content: body };
        });
      fd.append('history', JSON.stringify(history));

      // Send a snapshot of the project so the model can answer questions
      // about it AND target specific rows / templates with tool calls.
      // We include up to MAX_ROWS device rows from the active equipment so
      // "row 3 …" style commands have something concrete to resolve.
      const MAX_ROWS = 80;
      const slimRow = (r: any) => ({
        rowNumber: r.rowNumber,
        templateName: r.templateName || '',
        wiringType:   r.wiringType   || '',
        ratingPower:  r.ratingPower  || '',
        flc:          r.flc          || '',
        feederNo:     r.feederNo     || '',
        busSection:   r.busSection   || '',
        tag:          r.tag          || '',
        cableSize:    r.cableSize    || '',
        sfdHfd:       r.sfdHfd       || '',
        moduleNo:     r.moduleNo     || '',
        size:         r.size         || '',
        description:  r.description  || '',
      });

      const slimTemplate = (t: any) => ({
        id:   t.id,
        name: t.name,
        type: t.type,
        hierarchyPath: t.hierarchy?.path || [],
        leafKind:      t.hierarchy?.leafKind || null,
        kw:            t.hierarchy?.params?.kw || null,
        currentA:      t.hierarchy?.params?.currentA || null,
      });

      const activeDevices = selectedEquipment?.devices ?? [];
      const slimLibDevice = (d: any) => ({
        id: d.id, name: d.name, type: d.type,
        // Surface only frequently-referenced library props to keep token usage low.
        ip: d.properties?.ip || null,
        ral: d.properties?.ral || null,
        frequency: d.properties?.frequency || null,
        height: d.properties?.height || null,
        width: d.properties?.width || null,
      });

      const ctxSnapshot = {
        projectName:       projectData.projectName,
        projectId:         projectData.projectId,
        projectNumber:     projectData.projectNumber,
        client:            projectData.client,
        location:          projectData.location,
        standard:          projectData.standard,
        country:           projectData.country,
        language:          projectData.language,
        planner:           projectData.planner,
        designOffice:      projectData.designOffice,
        techSettings:      projectData.techSettings || null,
        activeTab:         activeTab != null ? {
          index: activeTab,
          label: TAB_LABELS[activeTab] || '?',
          owns:  TAB_SCOPE[activeTab] || '',
        } : null,
        activeEquipment:   selectedEquipment ? {
          id:        selectedEquipment.id,
          name:      selectedEquipment.name,
          type:      selectedEquipment.type,
          rowCount:  activeDevices.length,
          rows:      activeDevices.slice(0, MAX_ROWS).map(slimRow),
          rowsTruncated: activeDevices.length > MAX_ROWS,
        } : null,
        allEquipments: (projectData.equipments ?? []).map(e => ({
          id: e.id, name: e.name, type: e.type, rows: e.devices?.length ?? 0,
        })),
        templates: {
          LV: (projectData.templates?.LV ?? []).map(slimTemplate),
          MV: (projectData.templates?.MV ?? []).map(slimTemplate),
          HV: (projectData.templates?.HV ?? []).map(slimTemplate),
        },
        deviceLibrary: {
          LV: (projectData.deviceLibrary?.LV ?? []).map(slimLibDevice),
          MV: (projectData.deviceLibrary?.MV ?? []).map(slimLibDevice),
          HV: (projectData.deviceLibrary?.HV ?? []).map(slimLibDevice),
        },
      };
      fd.append('context', JSON.stringify(ctxSnapshot));
      if (agentMode) fd.append('tools', JSON.stringify(chatToolSchemas()));
      if (excelPreviews.length > 0) fd.append('excelPreviews', JSON.stringify(excelPreviews));
      filesToSend.forEach(a => fd.append('files', a.file, a.file.name));

      const res = await fetch(endpoint, { method: 'POST', body: fd });
      let raw = '';
      let backendExtractedDocs: { name: string; text: string }[] | undefined;
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('application/json')) {
        const j = await res.json();
        // Backend echoes back the text it extracted from any PDFs/Excels —
        // we stash that on the user's message so future turns can re-send
        // it as history without the user re-uploading the file.
        if (j && Array.isArray(j._extractedDocs)) {
          backendExtractedDocs = j._extractedDocs;
        }
        // The backend says which model and host actually answered — worth
        // showing, because "the AI is not working" is usually "the AI is not
        // the one you think it is".
        if (j && (j._model || j._host)) {
          setModelNote([j._model, j._host].filter(Boolean).join(' @ '));
        }
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

      // Persist extracted document text on the user message so the next
      // turn's history payload still carries it.
      if (backendExtractedDocs && backendExtractedDocs.length > 0) {
        setMessages(prev => prev.map(m =>
          m.id === userMsg.id ? { ...m, extractedDocs: backendExtractedDocs } : m
        ));
      }

      const { reply, tool_calls } = parseToolEnvelope(raw);
      let callsToRun = agentMode ? tool_calls : [];

      // Fallback intent parser — if the model didn't emit any tool_calls
      // (gpt-oss-20b often refuses, returning prose instead), try to match
      // the user's prompt against a handful of common command shapes
      // (row/cell edits, colours, tech-setting fields, project fields,
      // tab navigation, bulk updates). This guarantees that "row 3 feederNo
      // to L03" style commands always do *something*, even when the LLM is
      // being uncooperative.
      let fallbackUsed = false;
      if (agentMode && callsToRun.length === 0) {
        // One line can carry several instructions ("سطح دریا 2000 و دما را
        // بکن 50"); each becomes its own call.
        const intents = intentParseAll(text, { projectData, selectedEquipment, activeTab });
        if (intents.length > 0) {
          callsToRun = intents.map(i => i.call);
          fallbackUsed = true;
        }
      }

      // In review mode nothing that changes the project runs on its own: it
      // is staged into the approval card below and an engineer presses Apply.
      // Reads and navigation still run, so the answer above the card is the
      // real state of the project rather than a guess.
      const staged: ChatToolCall[] = [];
      const runNow: ChatToolCall[] = [];
      for (const call of callsToRun) {
        if (reviewMode && isMutatingTool(call.name)) staged.push(call);
        else runNow.push(call);
      }

      // Run the tools that are allowed to run. The full context handle set
      // lets the AI drive every tab (project metadata, device library,
      // templates, equipment, rows, navigation).
      let toolResults: ChatToolResult[] = [];
      if (runNow.length > 0) {
        toolResults = await executeChatToolBatch(runNow, toolContext());
      }

      // Pull out `propose_changes` results — those are staged for user
      // approval rather than counted as already-executed actions. Their
      // tool result still gets shown (as the "Staged N change(s)" line) but
      // the actual edits land via the ProposalCard component when the user
      // clicks Apply.
      const proposals: { title: string; actions: ProposedAction[] }[] = [];
      toolResults.forEach((r) => {
        const proposal = r?.data?.proposal;
        if (proposal && Array.isArray(proposal.actions)) {
          proposals.push({ title: String(proposal.title || 'Proposed changes'), actions: proposal.actions });
        }
      });
      if (staged.length > 0) {
        const where = activeTab != null ? TAB_LABELS[activeTab] : null;
        proposals.push({
          title: where ? `Proposed changes — ${where}` : 'Proposed changes',
          actions: staged.map(c => ({
            name: c.name, args: c.args || {}, summary: describeToolCall(c),
          })),
        });
      }

      // If the model gave an empty / unstructured reply but the fallback
      // matched something, prefix the reply with a one-line note so the
      // user knows the action came from a heuristic rather than the AI.
      const finalReply = (() => {
        let base = reply || (callsToRun.length > 0
          ? `Prepared ${callsToRun.length} action(s).`
          : '(empty reply)');
        if (fallbackUsed) {
          base = `_The model didn't return an action, so your prompt was matched against the known commands._\n\n${base}`;
        }
        if (staged.length > 0) {
          base += `\n\n_Nothing has changed yet — review the ${staged.length} item(s) below and press **Apply**._`;
        }
        return base;
      })();

      setMessages(prev => prev.map(m =>
        m.id === pendingId ? {
          ...m,
          text: finalReply,
          toolResults: toolResults.map((r, i) => ({
            tool: runNow[i]?.name || '?',
            summary: r.summary,
            ok: r.ok,
          })),
          proposals,
          pending: false,
        } : m
      ));
    } catch (err: any) {
      const msg = err?.message || String(err);
      // Common "Failed to fetch" → either the backend is down, or nginx
      // rejected the body size (PDFs + history pushes past 1 MB default),
      // or the model timed out. Surface a pointer the user can act on.
      const hint = /Failed to fetch|NetworkError|aborted/i.test(msg)
        ? '\n\nCommon causes:\n' +
          '• The simorgh-soft Node backend (port 3001) is not running — `docker compose logs simorgh-soft`.\n' +
          '• The request body exceeded the nginx limit. We set `client_max_body_size 50M` in `simorgh-agent/simorgh-soft/docker/nginx.conf` — re-build the container if you uploaded a large PDF.\n' +
          '• The local model (the VLM on 192.168.1.61 by default) timed out or refused the call — check `docker compose logs -n 50 simorgh-soft`, and that the model host allows this server.'
        : `\n\nCheck the endpoint at "${endpoint}" is reachable from the browser.`;
      setMessages(prev => prev.map(m =>
        m.id === pendingId
          ? { ...m, text: `❌ ${msg}${hint}`, error: true, pending: false }
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

  // ── Put away: nothing at all, and the workspace has the whole width ─────
  // Not even the rail. That is what closing means as against collapsing, and
  // View → Panels is what remembers it exists.
  if (!panel.open) return null;

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
          <SimorghMark className="w-6 h-6" white />
        </button>
        <span className="mt-3 text-[10px] font-semibold text-indigo-700 [writing-mode:vertical-rl] rotate-180 tracking-widest">
          SIMORGH&nbsp;AI
        </span>
        {/* Put the whole column away, not just the chat. The rail is 48px of
            width the workspace could be using, and View → Panels brings it
            back — so this is safe to press. */}
        <button
          onClick={panel.hide}
          title="Close the assistant — View → Panels brings it back"
          className="mt-auto mb-3 p-1.5 rounded text-indigo-400 hover:text-indigo-800 hover:bg-indigo-100"
        >
          <XIcon className="w-3.5 h-3.5" />
        </button>
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
          <SimorghMark className="w-5 h-5" white />
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
            title="Collapse to the side rail"
            onClick={() => setOpen(false)}
            className="p-1.5 rounded hover:bg-blue-700"
          >
            <MinusIcon className="w-4 h-4" />
          </button>
          <button
            title="Close the assistant — View → Panels brings it back"
            onClick={() => { setMaximized(false); panel.hide(); }}
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
        <label
          className="inline-flex items-center gap-1 text-xs text-gray-600"
          title="Nothing is written into the project until you read the proposed changes and press Apply. Turn this off only if you want the assistant to edit directly."
        >
          <input
            type="checkbox"
            checked={reviewMode}
            onChange={e => setReviewMode(e.target.checked)}
            className="accent-amber-600"
            disabled={!agentMode}
          />
          Review
        </label>
        <button
          className="ml-auto text-xs text-red-600 hover:underline flex items-center gap-1"
          onClick={clearChat}
          title="Clear conversation"
        >
          <Trash2Icon className="w-3 h-3" /> Clear
        </button>
      </div>

      {/* What the assistant is looking at, and what answered last turn. */}
      <div className="border-b border-gray-200 px-3 py-1 flex items-center gap-2 text-[10px] text-gray-500 bg-white flex-shrink-0">
        <span className="px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 font-medium">
          {activeTab != null ? TAB_LABELS[activeTab] : 'No tab'}
        </span>
        <span className="truncate">
          {reviewMode
            ? 'changes are proposed here and applied by you'
            : 'changes are applied straight away'}
        </span>
        {modelNote && <span className="ml-auto font-mono truncate max-w-[45%]" title={modelNote}>{modelNote}</span>}
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
              {m.role === 'user' ? <UserIcon className="w-3.5 h-3.5" /> : <SimorghMark className="w-4 h-4" />}
            </div>
            <div className={`max-w-[85%] rounded-lg px-3 py-2 text-sm break-words ${
              m.role === 'user'
                ? 'bg-blue-600 text-white whitespace-pre-wrap'
                : m.error
                  ? 'bg-red-50 text-red-800 border border-red-200 whitespace-pre-wrap'
                  : 'bg-white text-gray-800 border border-gray-200'
            }`}>
              {m.pending ? (
                <span className="inline-flex items-center gap-2 text-gray-500">
                  <Loader2Icon className="w-3.5 h-3.5 animate-spin" />
                  thinking…
                </span>
              ) : (
                <>
                  {/* User & error messages stay literal; assistant replies
                      render as Markdown so headings/lists/tables/code show
                      with proper formatting. */}
                  {m.role === 'assistant' && !m.error
                    ? <MarkdownView text={m.text} />
                    : <div>{m.text}</div>}
                  {/* Interactive preview cards for staged proposals. The
                      AI returns these from `propose_changes` whenever the
                      user uploads a document and asks to extract fields. */}
                  {m.proposals && m.proposals.length > 0 && m.proposals.map((p, i) => (
                    <ProposalCard
                      key={i}
                      title={p.title}
                      actions={p.actions}
                      ctx={toolContext()}
                      onApplied={results => {
                        setMessages(prev => prev.map(mm =>
                          mm.id === m.id ? {
                            ...mm,
                            toolResults: [...(mm.toolResults || []), ...results],
                          } : mm
                        ));
                      }}
                    />
                  ))}
                  {/* Filter out the propose_changes "Staged N change(s)"
                      noise — the ProposalCard above conveys the same info
                      more clearly. */}
                  {m.toolResults && m.toolResults.filter(tr => tr.tool !== 'propose_changes').length > 0 && (
                    <div className="mt-2 space-y-1 border-t border-gray-200/40 pt-1.5">
                      {m.toolResults.filter(tr => tr.tool !== 'propose_changes').map((tr, i) => (
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
