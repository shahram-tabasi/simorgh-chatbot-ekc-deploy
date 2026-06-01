import React from 'react';
import axios from 'axios';
import { AnimatePresence, motion } from 'framer-motion';
import { GitBranchIcon, FolderGitIcon, CpuIcon, FileDiffIcon, ExternalLinkIcon } from 'lucide-react';
import WelcomeScreen from './WelcomeScreen';
import GeneralWelcome from './GeneralWelcome';
import { useAuth, isLegacyUser } from '../context/AuthContext';
import { MessageList } from './MessageList';
import DesignSuitePanel from './DesignSuitePanel';
import DesignSuiteInline from './DesignSuiteInline';
import { ChatInput } from './ChatInput';
import { Message, UploadedFile } from '../types';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

export interface ChatHeaderContext {
  repoPath?: string | null;
  workingBranch?: string | null;
  baseBranch?: string | null;
  projectName?: string | null;
  model?: string | null;
  filesChanged?: number | null;
  /** Internal project UUID — needed by the diff-stat polling. */
  projectId?: string | null;
}

interface DiffStats {
  files_changed: number;
  insertions: number;
  deletions: number;
}

/** Poll /git/diffstat for the active project so the chat input can
 * paint the +N -M chips. Returns null until the first probe lands. */
function useProjectDiffStats(projectId?: string | null): DiffStats | null {
  const [stats, setStats] = React.useState<DiffStats | null>(null);
  React.useEffect(() => {
    if (!projectId) { setStats(null); return; }
    let cancelled = false;
    const tick = async () => {
      try {
        const token = localStorage.getItem('simorgh_token');
        if (!token) return;
        const res = await axios.get(
          `${API_BASE}/v2/agent/projects/${projectId}/git/diffstat`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (cancelled) return;
        const d = res.data || {};
        setStats({
          files_changed: d.files_changed ?? 0,
          insertions:    d.insertions ?? 0,
          deletions:     d.deletions ?? 0,
        });
      } catch {
        // best-effort — leave previous value
      }
    };
    tick();
    const id = window.setInterval(tick, 30_000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [projectId]);
  return stats;
}

// Build a GitLab web URL from a repo path. We hit env-configurable hosts
// via VITE_GITLAB_BASE_URL so on-prem / dev / prod stay decoupled.
function gitlabUrl(repoPath: string, suffix = ''): string {
  const base = (import.meta.env.VITE_GITLAB_BASE_URL as string | undefined)
    || 'https://gitlab.electrokavir.com';
  return `${base.replace(/\/$/, '')}/${repoPath}${suffix}`;
}

interface ChatAreaProps {
  messages: Message[];
  isTyping: boolean;
  onSendMessage: (content: string, files?: UploadedFile[]) => void;
  onRegenerateResponse?: (messageId: string) => void;
  onUpdateReaction?: (messageId: string, reaction: 'like' | 'dislike' | 'none') => void;
  onSwitchVersion?: (messageId: string, versionIndex: number) => void;
  onEditMessage?: (message: Message) => void;
  onCancelGeneration?: () => void;
  disabled?: boolean;
  editingMessage?: Message | null;
  isProjectChat?: boolean; // NEW: Indicates if this is a project-specific chat
  quotaExceeded?: boolean;
  headerContext?: ChatHeaderContext | null;
  /** The currently selected chat's id. Used to suppress the welcome-
   * screen flash when switching between existing chats whose history
   * is still loading asynchronously. */
  activeChatId?: string | null;
  /** Wired-up QuotaIndicator forwarded to ChatInput so the per-day
   * remaining-questions ring shows next to the "Simorgh AI" label
   * in the composer footer. App.tsx supplies this for modern users
   * (it wraps useQuota); legacy/unlimited users pass undefined and
   * ChatInput falls back to its idle typing-pulse spinner. */
  quotaIndicator?: React.ReactNode;
}

function ChatHeaderChip({ ctx }: { ctx: ChatHeaderContext }) {
  const repo = ctx.repoPath || ctx.projectName;
  const branch = ctx.workingBranch || ctx.baseBranch;
  const model = ctx.model;
  const files = ctx.filesChanged;
  if (!repo && !branch && !model) return null;

  // Action row only makes sense for real GitLab-linked sessions, not
  // synthetic "project name only" rows.
  const hasRepo = Boolean(ctx.repoPath);
  const repoHref = hasRepo ? gitlabUrl(ctx.repoPath as string) : null;
  const branchHref = hasRepo && branch
    ? gitlabUrl(ctx.repoPath as string, `/-/tree/${encodeURIComponent(branch)}`)
    : null;
  const mrHref = hasRepo && branch && ctx.baseBranch
    ? gitlabUrl(ctx.repoPath as string,
        `/-/merge_requests/new?merge_request[source_branch]=${encodeURIComponent(branch)}` +
        `&merge_request[target_branch]=${encodeURIComponent(ctx.baseBranch)}`)
    : null;

  return (
    <div className="flex-shrink-0 w-full flex flex-col items-center gap-1.5 pt-2 px-2 sm:px-4 md:px-8 lg:px-20">
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/[0.04] border border-white/10 text-xs text-gray-300 backdrop-blur-sm max-w-full overflow-hidden">
        {repo && (
          <span className="flex items-center gap-1.5 min-w-0">
            <FolderGitIcon className="w-3.5 h-3.5 text-sky-300/80 flex-shrink-0" />
            <span className="truncate font-mono text-gray-200">{repo}</span>
          </span>
        )}
        {branch && (
          <>
            <span className="text-white/15">·</span>
            <span className="flex items-center gap-1.5 min-w-0">
              <GitBranchIcon className="w-3.5 h-3.5 text-emerald-300/80 flex-shrink-0" />
              <span className="truncate font-mono text-gray-200">{branch}</span>
            </span>
          </>
        )}
        {model && (
          <>
            <span className="text-white/15">·</span>
            <span className="flex items-center gap-1.5 min-w-0">
              <CpuIcon className="w-3.5 h-3.5 text-violet-300/80 flex-shrink-0" />
              <span className="truncate text-gray-200">{model}</span>
            </span>
          </>
        )}
        {typeof files === 'number' && files > 0 && (
          <>
            <span className="text-white/15">·</span>
            <span className="flex items-center gap-1.5 min-w-0">
              <FileDiffIcon className="w-3.5 h-3.5 text-amber-300/80 flex-shrink-0" />
              <span className="text-amber-200/90 font-medium">{files} file{files === 1 ? '' : 's'}</span>
            </span>
          </>
        )}
      </div>
      {(repoHref || branchHref || mrHref) && (
        <div className="flex items-center gap-3 text-[11px] text-gray-500">
          {repoHref && (
            <a href={repoHref} target="_blank" rel="noreferrer"
               className="flex items-center gap-1 hover:text-gray-200 transition">
              <ExternalLinkIcon className="w-3 h-3" />
              Open repo
            </a>
          )}
          {branchHref && (
            <a href={branchHref} target="_blank" rel="noreferrer"
               className="flex items-center gap-1 hover:text-gray-200 transition">
              <GitBranchIcon className="w-3 h-3" />
              View branch
            </a>
          )}
          {mrHref && (
            <a href={mrHref} target="_blank" rel="noreferrer"
               className="flex items-center gap-1 hover:text-emerald-300 transition">
              <ExternalLinkIcon className="w-3 h-3" />
              Open MR
            </a>
          )}
        </div>
      )}
    </div>
  );
}

export function ChatArea({
  messages,
  isTyping,
  onSendMessage,
  onRegenerateResponse,
  onUpdateReaction,
  onSwitchVersion,
  onEditMessage,
  onCancelGeneration,
  disabled = false,
  editingMessage = null,
  isProjectChat = false,
  quotaExceeded = false,
  headerContext = null,
  activeChatId = null,
  quotaIndicator = null,
}: ChatAreaProps) {
  const [promptToInsert, setPromptToInsert] = React.useState<string | null>(null);
  // True after the user has sent a message in this chat. Kept for the
  // existing handleSend path (transitions from idle → chat on first
  // send) — no longer used to gate the welcome screen.
  const [isChatting, setIsChatting] = React.useState(false);
  const { user } = useAuth();
  const legacy = user ? isLegacyUser(user) : false;

  // Lock in chatting view on any chat switch where messages exist or
  // are about to. Used to clear the welcome state when navigating
  // from no-chat into a chat with history.
  React.useEffect(() => {
    if (messages.length > 0) {
      setIsChatting(true);
    }
  }, [messages.length]);

  // Welcome screen rules:
  //  - No active chat → show welcome (entry state for legacy/edge cases).
  //  - General chat with zero messages → also show welcome so the
  //    operator gets the Persian HR prompts on the auto-created chat.
  //  - Project chat with zero messages → MessageList stays (project
  //    chats already render the project-specific WelcomeScreen above).
  const isIdle =
    !activeChatId ||
    (!isProjectChat && messages.length === 0 && !isTyping);

  // Live diff stats for the chat-input header's +N -M chips.
  const diffStats = useProjectDiffStats(headerContext?.projectId ?? null);

  // The token-budget ring reads off the most recent assistant message
  // (set by useChat.sendMessage from the backend's token_budget field).
  const tokenUsage = React.useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== 'assistant') continue;
      const tb = (m.metadata as any)?.token_budget;
      if (tb && (tb.context_limit || tb.used_tokens != null)) {
        const used = (tb.fixed_tokens ?? 0) + (tb.used_tokens ?? 0);
        return { used, total: tb.context_limit ?? null };
      }
    }
    return null;
  }, [messages]);

  // "Actively generating" = either we're waiting for the first
  // response chunk (isTyping) OR a stream is still feeding the last
  // assistant message (metadata.streaming). useChat flips isTyping
  // to false as soon as the first agent_plan event arrives, but
  // project-chat CoT keeps streaming for tens of seconds after
  // that. The Stop button + CoT timer both need to stay live for
  // the whole duration, so derive the broader flag here.
  const isActivelyGenerating = React.useMemo(() => {
    if (isTyping) return true;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== 'assistant') continue;
      return Boolean((m.metadata as any)?.streaming);
    }
    return false;
  }, [isTyping, messages]);

  // Build the props for ChatInput's status row. Reused by the two
  // ChatInput call sites below (idle + chatting modes).
  const chatInputHeader = headerContext && (headerContext.repoPath || headerContext.workingBranch)
    ? {
        repoPath:      headerContext.repoPath ?? null,
        workingBranch: headerContext.workingBranch ?? null,
        baseBranch:    headerContext.baseBranch ?? null,
        projectName:   headerContext.projectName ?? null,
        filesChanged:  diffStats?.files_changed ?? headerContext.filesChanged ?? null,
        insertions:    diffStats?.insertions ?? null,
        deletions:     diffStats?.deletions ?? null,
      }
    : null;

  // Handle double-click to execute prompt directly
  const handlePromptDoubleClick = (prompt: string) => {
    if (!disabled && prompt) {
      handleSend(prompt);
    }
  };

  // Handle single click to insert prompt
  const handlePromptClick = (prompt: string) => {
    if (!disabled) {
      setPromptToInsert(prompt);
      // Reset after a brief moment to allow the effect to trigger
      setTimeout(() => setPromptToInsert(null), 100);
    }
  };

  // Wrap onSendMessage to detect first send
  const handleSend = React.useCallback((content: string, files?: UploadedFile[]) => {
    // If this is the first message (idle state), transition to chatting
    if (isIdle) {
      setIsChatting(true);
    }
    onSendMessage(content, files);
  }, [isIdle, onSendMessage]);

  // (Removed: the previous auto-reset to idle when messages.length === 0
  // fired during every chat switch — the messages prop is briefly []
  // while the new chat's history is fetching, which flashed the welcome
  // screen on every switch. Resetting now happens via the chat-switch
  // effect above with an isAwaitingHistory guard.)

  return (
    <div className="flex-1 flex flex-col h-full relative overflow-hidden w-full max-w-full min-w-0">
      {/* IDLE MODE: Welcome content with ChatInput integrated.
          Scroll-then-center pattern:
            outer = single scroll container (overflow-y-auto)
            inner = min-h-full + flex justify-center
          This centers content when it fits AND lets the page scroll
          when it doesn't — fixes the Android Chrome case where
          `flex justify-center + overflow-y-auto` on the same node
          pushed the logo above scroll-top and trapped the prompts
          off-screen, making the page look frozen. */}
      {isIdle && (
        <div className="flex-1 overflow-y-auto overflow-x-hidden w-full min-w-0">
          {/* On desktop (lg+) the welcome anchors near the top with
              padding (lg:justify-start lg:pt-12) and the column is
              wider (lg:max-w-5xl) per operator request — keeps the
              prompts above the fold instead of pushing them into the
              vertical middle of a 1080p screen. On mobile the
              previous "center vertically" behavior is preserved. */}
          <div className="min-h-full w-full max-w-3xl lg:max-w-5xl mx-auto flex flex-col items-center justify-center lg:justify-start px-2 sm:px-4 md:px-8 lg:px-12 py-4 lg:pt-12 min-w-0">
            {/* Legacy/TPMS operators are electrical engineers using
                project chats — they should see the English electrical
                WelcomeScreen (Short Circuit, Transformer Ratings, …)
                even on the no-project idle screen. Modern (HR) users
                see the Persian HR prompts in GeneralWelcome. */}
            {isProjectChat || legacy ? (
              <WelcomeScreen
                onHide={() => {}}
                onPromptClick={handlePromptClick}
                onPromptDoubleClick={handlePromptDoubleClick}
              />
            ) : (
              <GeneralWelcome
                onHide={() => {}}
                onPromptClick={handlePromptClick}
                onPromptDoubleClick={handlePromptDoubleClick}
              />
            )}
            {/* ChatInput - part of welcome content, centered */}
            <div className="w-full px-2 sm:px-4 mt-3">
              <ChatInput
                onSend={handleSend}
                onCancel={onCancelGeneration}
                disabled={disabled || isTyping}
                isGenerating={isActivelyGenerating}
                editMessage={editingMessage ? { content: editingMessage.content, files: editingMessage.files } : null}
                promptToInsert={promptToInsert}
                centered={true}
                quotaExceeded={quotaExceeded}
                uploadsAllowed={isProjectChat}
                header={chatInputHeader}
                modelLabel="Simorgh AI"
                showCotTimer={isProjectChat}
                tokenUsage={tokenUsage}
                quotaIndicator={quotaIndicator}
              />
            </div>
          </div>
        </div>
      )}

      {/* CHATTING MODE: Messages with fixed bottom ChatInput */}
      {!isIdle && (
        <>
          {/* The standalone chip duplicates the chat-input top bar
              whenever the input shows repo/branch (project chats with
              a real GitLab link). Hide it then so we don't double up. */}
          {isProjectChat && headerContext && !chatInputHeader && (
            <ChatHeaderChip ctx={headerContext} />
          )}
          {/* Remove overflow-y-auto from here - let MessageList handle scrolling */}
          <div className="flex-1 flex flex-col pt-2 md:pt-2 overflow-hidden px-2 sm:px-4 md:px-8 lg:px-20">
            {/* Design Suite slot-collector status + inline ask_user forms.
                The background collector keeps the spec live; this surface
                shows completeness and any pending clarifications. Answers
                submitted here auto-fire a follow-up chat message so the
                ReAct loop sees the resolved gaps and can submit. The old
                DesignSuitePanel button stays below as a one-shot fallback. */}
            {legacy && isProjectChat && headerContext?.projectId && (
              <>
                <DesignSuiteInline
                  projectId={headerContext.projectId}
                  isLegacy={legacy}
                  onAnswered={(note) => handleSend(note)}
                />
                <DesignSuitePanel projectId={headerContext.projectId} isLegacy={legacy} />
              </>
            )}
            <MessageList
              messages={messages}
              isTyping={isTyping}
              onRegenerateResponse={onRegenerateResponse}
              onUpdateReaction={onUpdateReaction}
              onSwitchVersion={onSwitchVersion}
              onEditMessage={onEditMessage}
              chatId={activeChatId}
            />
          </div>

          {/* ChatInput - fixed at bottom in chatting mode */}
          <div
            className="w-full flex-shrink-0 flex justify-center pb-4 sm:pb-6 md:pb-8 border-t border-transparent backdrop-blur-xl"
            style={{ paddingBottom: `max(1rem, calc(1rem + env(safe-area-inset-bottom)))` }}
          >
            <div className="w-full px-2 sm:px-4 max-w-4xl lg:max-w-5xl">
              <ChatInput
                onSend={handleSend}
                onCancel={onCancelGeneration}
                disabled={disabled || isTyping}
                isGenerating={isActivelyGenerating}
                editMessage={editingMessage ? { content: editingMessage.content, files: editingMessage.files } : null}
                promptToInsert={promptToInsert}
                centered={false}
                quotaExceeded={quotaExceeded}
                uploadsAllowed={isProjectChat}
                header={chatInputHeader}
                modelLabel="Simorgh AI"
                showCotTimer={isProjectChat}
                tokenUsage={tokenUsage}
                quotaIndicator={quotaIndicator}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}