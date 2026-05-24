// src/hooks/useChat.ts
// Updated to use v2 API endpoints with chatbot_core integration
import { useState, useEffect, useRef, useCallback } from 'react';
import { Message, UploadedFile, AgentPlan, AgentTaskGroup, AgentSubtask } from '../types';
import axios from 'axios';
import { sendMessageHrStream } from '../services/chatbotV2Api';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const API_V2_CHAT = `${API_BASE}/v2/chat`;

// UUID-shaped user_id means a modern (postgres_auth) user; only modern
// users are eligible for the HR/Strategy direct-RAG fast path. Legacy
// TPMS users (EMPUSERNAME strings) keep the old flow.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isModernUser = (id?: string) => !!id && UUID_RE.test(id);

export interface ChatOptions {
  llmMode?: 'online' | 'offline' | null; // null = use default
  useGraphContext?: boolean;
  useStreaming?: boolean; // Enable streaming responses (default: true)
  groundedMode?: boolean; // If true, responses strictly from documents with citations
}

export function useChat(
  initialMessages: Message[] = [],
  chatId?: string | null,
  userId?: string,
  projectNumber?: string | null,
  onTitleGenerated?: (chatId: string, title: string) => void,
  onSpecTaskCreated?: (taskId: string) => void
) {
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [isTyping, setIsTyping] = useState(false);
  const [llmMode, setLlmMode] = useState<'online' | 'offline' | null>(null);
  const prevChatIdRef = useRef<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Load user's LLM preference on mount and when localStorage changes
  useEffect(() => {
    const loadLlmMode = () => {
      // const savedMode = localStorage.getItem('llm_mode') as 'online' | 'offline' | null;
      // if (savedMode) {
      //   setLlmMode(savedMode);
      //   console.log('🔄 Loaded LLM mode from storage:', savedMode);
      // } else {
      //   // Default to online if not set
      //   setLlmMode('online');
      //   localStorage.setItem('llm_mode', 'online');
      //   console.log('✅ Set default LLM mode: online');
      // }
      const savedMode = localStorage.getItem('llm_mode');
      if (savedMode === 'online' || savedMode === 'offline') {
        setLlmMode(savedMode);
        console.log('Loaded LLM mode from storage:', savedMode);
      } else {
        // Default offline — general chat always uses the local gpt-oss
        // path (hr_chat.py force_backend='text'); project chats now
        // honour this setting too. Previously defaulted to online,
        // which made the toggle have no effect since modern users were
        // also force-locked back to online elsewhere.
        setLlmMode('offline');
        localStorage.setItem('llm_mode', 'offline');
        console.log('Set default LLM mode: offline');
      }
    };

    loadLlmMode();

    // Listen for storage changes from other tabs/windows
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === 'llm_mode' && e.newValue) {
        setLlmMode(e.newValue as 'online' | 'offline');
        console.log('🔄 LLM mode changed via storage event:', e.newValue);
      }
    };

    // Listen for custom event from same window (SettingsPanel)
    const handleCustomModeChange = (e: Event) => {
      const customEvent = e as CustomEvent<'online' | 'offline'>;
      setLlmMode(customEvent.detail);
      console.log('🔄 LLM mode changed via custom event:', customEvent.detail);
    };

    window.addEventListener('storage', handleStorageChange);
    window.addEventListener('llm-mode-changed', handleCustomModeChange);

    return () => {
      window.removeEventListener('storage', handleStorageChange);
      window.removeEventListener('llm-mode-changed', handleCustomModeChange);
    };
  }, []);

  // Track previous messages length to detect actual changes
  const prevMessagesLengthRef = useRef<number>(0);

  // Reset messages when chatId changes OR when initialMessages updates (after async load)
  useEffect(() => {
    const chatIdChanged = chatId !== prevChatIdRef.current;
    const messagesChanged = initialMessages.length !== prevMessagesLengthRef.current;

    if (chatIdChanged) {
      console.log('🔄 Chat switched - ID changed from', prevChatIdRef.current, 'to', chatId);
      prevChatIdRef.current = chatId || null;
      prevMessagesLengthRef.current = 0; // Reset message tracking for new chat
    }

    // Update messages whenever initialMessages changes (including async loads)
    // This handles: 1) Chat switch, 2) Async message load, 3) New messages from other sources
    if (chatIdChanged || messagesChanged || initialMessages.length > 0) {
      console.log(`📝 Loading ${initialMessages.length} messages (chatId: ${chatId}, changed: ${chatIdChanged || messagesChanged})`);
      setMessages(initialMessages);
      prevMessagesLengthRef.current = initialMessages.length;
    }

    // Reset typing state only on chat switch
    if (chatIdChanged) {
      setIsTyping(false);
    }
  }, [chatId, initialMessages]);

  // useEffect(() => {
  //   if (chatId && chatId !== prevChatIdRef.current) {
  //     console.log('Chat switched to:', chatId);
  //     setMessages(initialMessages);
  //     setIsTyping(false);
  //   }
  //   prevChatIdRef.current = chatId || null;
  // }, [chatId]); // ← ONLY chatId here!

  // Streaming message sender using Server-Sent Events
  const sendMessageStreaming = useCallback(async (
    content: string,
    options?: ChatOptions
  ) => {
    if (!chatId || !userId) {
      console.error('❌ Cannot send message: chatId or userId missing');
      return;
    }

    const token = localStorage.getItem('simorgh_token');
    if (!token) {
      console.error('❌ No auth token found');
      const errorMessage: Message = {
        id: (Date.now() + 1).toString(),
        content: 'Authentication required. Please log in again.',
        role: 'assistant',
        timestamp: new Date(),
        metadata: { error: true }
      };
      setMessages(prev => [...prev, errorMessage]);
      return;
    }

    console.log('📤 Sending message (streaming):', content);

    // Cancel any ongoing request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    // Show typing indicator ONLY - no empty message yet
    setIsTyping(true);

    // Message will be added on first chunk
    const aiMessageId = (Date.now() + 1).toString();
    let messageAdded = false;

    // Agent plan state for Claude Code-style task display
    let currentAgentPlan: AgentPlan | null = null;

    // Helper: update agent plan in the message metadata
    const updateAgentPlan = (plan: AgentPlan) => {
      currentAgentPlan = plan;
      setMessages(prev => prev.map(msg =>
        msg.id === aiMessageId
          ? { ...msg, metadata: { ...msg.metadata, agentPlan: { ...plan } } }
          : msg
      ));
    };

    // Helper: process agent_plan event → create task groups
    const handleAgentPlan = (data: any) => {
      const tasks: AgentTaskGroup[] = (data.agent_plan?.tasks || []).map((t: any) => ({
        id: t.id,
        title: t.title,
        status: t.status || 'pending',
        subtasks: [],
      }));
      const plan: AgentPlan = { tasks };
      currentAgentPlan = plan;

      // Create the AI message immediately with the plan (before any text)
      if (!messageAdded) {
        messageAdded = true;
        setIsTyping(false);
        const aiMessage: Message = {
          id: aiMessageId,
          content: '',
          role: 'assistant',
          timestamp: new Date(),
          metadata: { streaming: true, agentPlan: plan },
        };
        setMessages(prev => [...prev, aiMessage]);
      } else {
        updateAgentPlan(plan);
      }
    };

    // Helper: process agent_step event → update task group or subtask status
    const handleAgentStep = (data: any) => {
      const step = data.agent_step;
      if (!step || !currentAgentPlan) return;

      const taskId = step.task_id;
      const subtaskId = step.subtask_id;
      const plan = currentAgentPlan;

      // Find the task group
      const taskGroup = plan.tasks.find(t => t.id === taskId);
      if (!taskGroup) return;

      if (subtaskId) {
        // Update or add a subtask
        const existing = taskGroup.subtasks.find(s => s.id === subtaskId);
        if (existing) {
          existing.status = step.status;
          if (step.detail) existing.detail = step.detail;
          if (step.title) existing.title = step.title;
        } else {
          taskGroup.subtasks.push({
            id: subtaskId,
            title: step.title || subtaskId,
            status: step.status,
            detail: step.detail,
            tool: step.tool,
          });
        }
      } else {
        // Update the task group status itself
        taskGroup.status = step.status;
        if (step.title) taskGroup.title = step.title;
      }

      updateAgentPlan(plan);
    };

    // Wizard project sessions (chat_id starts with `session_`) route through
    // project-agent-service /api/v2/agent/projects/{pid}/message/stream so
    // the CoT engine + MCP tools (gitlab-mcp, runtime-broker, etc.) actually
    // run. Legacy /api/chat/stream stays only for general chats.
    if (chatId.startsWith('session_')) {
      try {
        // Resolve project_id from the session token (one-time per session).
        const sessResp = await axios.get(
          `${API_BASE}/v2/chatbot/project/sessions/${chatId}`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        const projectId = sessResp.data.project_id;
        if (!projectId) throw new Error('session has no project_id');

        const url = `${API_BASE}/v2/agent/projects/${projectId}/message/stream`;
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
            'Accept': 'text/event-stream',
          },
          body: JSON.stringify({
            content,
            channel: 'chat',
            chat_id: chatId,
            // Honour the user's mode choice from SettingsPanel.
            // Default offline (local Simorgh AI on .61/.62); 'online'
            // uses the configured OpenAI/Anthropic API. The backend
            // accepts this on ProjectMessageCreate and falls back to
            // local if the requested online provider isn't configured.
            llm_mode: llmMode || 'offline',
          }),
          signal: abortControllerRef.current?.signal,
        });
        // 425 Too Early: project-init is still indexing this project
        // (Phase 3 of auto-exploration). Render a friendly inline
        // message that surfaces the current step so the user knows
        // what's happening, instead of a generic "HTTP 425" error
        // toast. The user can retry once init reports done.
        if (response.status === 425) {
          let progressText = 'Indexing project files…';
          try {
            const errBody = await response.json();
            const p = errBody?.detail?.progress;
            if (p?.current_step) {
              const completed = p.completed_count ?? p.completed_steps?.length ?? 0;
              const total = p.total_expected ?? 0;
              progressText = total
                ? `Indexing project — currently: ${p.current_step} (${completed}/${total})`
                : `Indexing project — currently: ${p.current_step}`;
            }
          } catch {
            // body wasn't JSON; keep the default progressText
          }
          setIsTyping(false);
          setMessages(prev => [...prev, {
            id: `system-${Date.now()}`,
            content:
              `🔄 ${progressText}\n\n` +
              'Your project is still being set up. ' +
              'This usually takes under a minute for small repos; ' +
              'large ones with many documents can take a few minutes ' +
              'while we extract and index the content. Please try ' +
              'your question again shortly.',
            role: 'assistant',
            timestamp: new Date(),
            metadata: { initBlocked: true } as any,
          }]);
          return;
        }
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} from project-agent`);
        }
        const reader = response.body?.getReader();
        if (!reader) throw new Error('No response body from project-agent');

        const decoder = new TextDecoder();
        let buffer = '';
        let curEvent = 'message';
        let curData = '';
        let accumulated = '';

        const flushEvent = () => {
          if (!curData) { curEvent = 'message'; return; }
          let payload: any = curData;
          try { payload = JSON.parse(curData); } catch {}
          if (curEvent === 'complete') {
            accumulated = payload.response || '';
            const tasks: AgentTaskGroup[] = (payload.tasks || []).map((t: any) => ({
              id: String(t.id || t.task_id || `task-${Math.random()}`),
              title: t.title || t.task_type || 'task',
              status: 'completed',
              subtasks: [],
            }));
            if (!messageAdded) {
              messageAdded = true;
              setIsTyping(false);
              setMessages(prev => [...prev, {
                id: aiMessageId,
                content: accumulated,
                role: 'assistant',
                timestamp: new Date(),
                metadata: {
                  streaming: false,
                  agentPlan: tasks.length ? { tasks } : currentAgentPlan || undefined,
                  cot_chain: payload.chain_id,
                  cot_reasoning: payload.reasoning,
                },
              }]);
            } else {
              setMessages(prev => prev.map(m =>
                m.id === aiMessageId
                  ? { ...m, content: accumulated, metadata: {
                      ...m.metadata, streaming: false,
                      agentPlan: tasks.length ? { tasks } : m.metadata?.agentPlan,
                      cot_chain: payload.chain_id, cot_reasoning: payload.reasoning,
                    } }
                  : m
              ));
            }
          } else if (curEvent === 'error') {
            setIsTyping(false);
            const errMsg: Message = {
              id: aiMessageId,
              content: `Error: ${payload.error || curData}`,
              role: 'assistant',
              timestamp: new Date(),
              metadata: { error: true },
            };
            if (!messageAdded) {
              messageAdded = true;
              setMessages(prev => [...prev, errMsg]);
            } else {
              setMessages(prev => prev.map(m => m.id === aiMessageId ? errMsg : m));
            }
          } else if (curEvent === 'ping') {
            // keepalive — ignore
          } else {
            // progress / step / anything-else → surface as an agent step
            const step = (payload && typeof payload === 'object' && payload.title)
              ? payload
              : { title: curEvent, status: 'active', detail: typeof payload === 'string' ? payload : '' };
            handleAgentStep({ agent_step: {
              task_id: step.task_id || `cot-${curEvent}`,
              status: step.status || 'active',
              title: step.title || curEvent,
              detail: step.detail,
              tool: step.tool || step.tool_needed,
            }});
            if (!currentAgentPlan) {
              // bootstrap a plan so subsequent steps have a place to live
              currentAgentPlan = { tasks: [{
                id: step.task_id || `cot-${curEvent}`,
                title: step.title || curEvent,
                status: 'active',
                subtasks: [],
              }] };
              if (!messageAdded) {
                messageAdded = true;
                setIsTyping(false);
                setMessages(prev => [...prev, {
                  id: aiMessageId, content: '', role: 'assistant',
                  timestamp: new Date(),
                  metadata: { streaming: true, agentPlan: currentAgentPlan },
                }]);
              }
            }
          }
          curEvent = 'message';
          curData = '';
        };

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let nl;
          while ((nl = buffer.indexOf('\n')) !== -1) {
            const rawLine = buffer.slice(0, nl).replace(/\r$/, '');
            buffer = buffer.slice(nl + 1);
            if (rawLine === '') { flushEvent(); continue; }
            if (rawLine.startsWith(':')) continue;          // SSE comment
            if (rawLine.startsWith('event: ')) curEvent = rawLine.slice(7).trim();
            else if (rawLine.startsWith('data: ')) curData = rawLine.slice(6);
          }
        }
        flushEvent();
        return;
      } catch (e: any) {
        console.error('project-agent stream failed:', e);
        setIsTyping(false);
        const errMsg: Message = {
          id: aiMessageId,
          content: `Failed to reach project agent: ${e.message || e}`,
          role: 'assistant',
          timestamp: new Date(),
          metadata: { error: true },
        };
        setMessages(prev => [...prev, errMsg]);
        return;
      }
    }

    // General chat for modern (UUID) users: route to the HR/Strategy
    // direct-RAG path. No planner, no MCP, no OpenAI — straight to
    // gpt-oss-20b on .61 via llm-gateway. The legacy /api/chat/stream
    // fallback below still applies to legacy TPMS users.
    if (isModernUser(userId) && !projectNumber) {
      try {
        await sendMessageHrStream(
          userId!,
          content,
          {
            onMeta: (meta) => {
              // Citations arrive BEFORE the first token. Stamp them on
              // a (still-empty) assistant message so the bubble renders
              // source badges while gpt-oss is generating.
              if (!messageAdded) {
                messageAdded = true;
                setIsTyping(false);
                setMessages(prev => [...prev, {
                  id: aiMessageId,
                  content: '',
                  role: 'assistant',
                  timestamp: new Date(),
                  metadata: {
                    streaming: true,
                    citations: meta.hits as any,
                    top_score: meta.top_score,
                  },
                }]);
              } else {
                setMessages(prev => prev.map(m => m.id === aiMessageId
                  ? { ...m, metadata: {
                      ...(m.metadata || {}),
                      citations: meta.hits as any,
                      top_score: meta.top_score,
                    }}
                  : m));
              }
            },
            onChunk: (delta) => {
              if (!messageAdded) {
                messageAdded = true;
                setIsTyping(false);
                setMessages(prev => [...prev, {
                  id: aiMessageId,
                  content: delta,
                  role: 'assistant',
                  timestamp: new Date(),
                  metadata: { streaming: true },
                }]);
              } else {
                setMessages(prev => prev.map(m => m.id === aiMessageId
                  ? { ...m, content: (m.content || '') + delta }
                  : m));
              }
            },
            onRefusal: (text) => {
              // Out-of-corpus query — refusal IS the assistant message;
              // suppress citation badges (no sources backed this) and
              // do NOT mark as error (otherwise the bubble turns red).
              if (!messageAdded) {
                messageAdded = true;
                setIsTyping(false);
                setMessages(prev => [...prev, {
                  id: aiMessageId,
                  content: text,
                  role: 'assistant',
                  timestamp: new Date(),
                  metadata: { refusal: true },
                }]);
              } else {
                setMessages(prev => prev.map(m => m.id === aiMessageId
                  ? { ...m, content: text, metadata: { ...(m.metadata||{}), refusal: true, citations: undefined } }
                  : m));
              }
            },
            onDone: () => {
              setMessages(prev => prev.map(m => m.id === aiMessageId
                ? { ...m, metadata: { ...(m.metadata||{}), streaming: false } }
                : m));
            },
            onError: (err) => {
              console.error('hr_chat stream failed:', err);
              setIsTyping(false);
              if (!messageAdded) {
                setMessages(prev => [...prev, {
                  id: aiMessageId,
                  content: `Error: ${err.message}`,
                  role: 'assistant',
                  timestamp: new Date(),
                  metadata: { error: true },
                }]);
              } else {
                setMessages(prev => prev.map(m => m.id === aiMessageId
                  ? { ...m, content: `Error: ${err.message}`,
                      metadata: { ...(m.metadata||{}), error: true, streaming: false } }
                  : m));
              }
            },
          },
          undefined,
          // Wire the abort controller signal so the Stop button in
          // ChatInput actually halts the SSE stream from gpt-oss.
          abortControllerRef.current?.signal,
        );
      } finally {
        setIsTyping(false);
      }
      return;
    }

    try {
      const response = await fetch(`${API_BASE}/chat/stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'Accept': 'text/event-stream'
        },
        body: JSON.stringify({
          chat_id: chatId,
          user_id: userId,
          content: content,
          llm_mode: llmMode || undefined,
          use_graph_context: options?.useGraphContext !== false,
          grounded_mode: options?.groundedMode || false
        }),
        signal: abortControllerRef.current?.signal
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('No response body');
      }

      const decoder = new TextDecoder();
      let accumulatedContent = '';
      let finalLlmMode: string | undefined;
      let contextUsed = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const text = decoder.decode(value, { stream: true });
        const lines = text.split('\n');

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));

              // Handle error
              if (data.error) {
                console.error('❌ Streaming error:', data.error);
                setIsTyping(false);
                const errorMessage: Message = {
                  id: aiMessageId,
                  content: `Error: ${data.message || data.error}`,
                  role: 'assistant',
                  timestamp: new Date(),
                  metadata: { error: true }
                };
                if (!messageAdded) {
                  setMessages(prev => [...prev, errorMessage]);
                } else {
                  setMessages(prev => prev.map(msg =>
                    msg.id === aiMessageId ? errorMessage : msg
                  ));
                }
                return;
              }

              // Handle agent_plan event (Claude Code-style task list)
              if (data.agent_plan) {
                handleAgentPlan(data);
                continue;
              }

              // Handle agent_step event (task/subtask status update)
              if (data.agent_step) {
                handleAgentStep(data);
                continue;
              }

              // Handle metadata (including new memory stats)
              if (data.context_used !== undefined) {
                contextUsed = data.context_used;
              }

              // Log memory stats if available (for debugging)
              if (data.memory_stats) {
                console.log('🧠 Memory context:', data.memory_stats);
              }

              // Handle chunk - add message on FIRST chunk, update on subsequent
              if (data.chunk) {
                accumulatedContent += data.chunk;

                if (!messageAdded) {
                  // First chunk: hide dots, add message with content
                  messageAdded = true;
                  setIsTyping(false);
                  const aiMessage: Message = {
                    id: aiMessageId,
                    content: accumulatedContent,
                    role: 'assistant',
                    timestamp: new Date(),
                    metadata: { streaming: true, agentPlan: currentAgentPlan || undefined }
                  };
                  setMessages(prev => [...prev, aiMessage]);
                } else {
                  // Subsequent chunks: update message content
                  setMessages(prev => prev.map(msg =>
                    msg.id === aiMessageId
                      ? { ...msg, content: accumulatedContent }
                      : msg
                  ));
                }
              }

              // Handle completion
              if (data.done) {
                finalLlmMode = data.llm_mode;
                setMessages(prev => prev.map(msg =>
                  msg.id === aiMessageId
                    ? {
                        ...msg,
                        content: accumulatedContent,
                        metadata: {
                          llm_mode: finalLlmMode,
                          context_used: contextUsed,
                          memory_enhanced: data.memory_enhanced || false,
                          streaming: false,
                          agentPlan: currentAgentPlan || undefined,
                        }
                      }
                    : msg
                ));
                console.log('✅ Streaming complete', data.memory_enhanced ? '(with memory context)' : '');
                showNotification('Response Ready!', accumulatedContent.slice(0, 100));
              }
            } catch (e) {
              // Skip malformed JSON lines
              console.warn('⚠️ Failed to parse SSE data:', line);
            }
          }
        }
      }

      // Handle stream ended without explicit done signal
      if (!messageAdded && accumulatedContent) {
        setIsTyping(false);
        const aiMessage: Message = {
          id: aiMessageId,
          content: accumulatedContent,
          role: 'assistant',
          timestamp: new Date(),
          metadata: {
            llm_mode: finalLlmMode,
            context_used: contextUsed,
            streaming: false,
            agentPlan: currentAgentPlan || undefined,
          }
        };
        setMessages(prev => [...prev, aiMessage]);
      } else if (messageAdded) {
        setMessages(prev => prev.map(msg =>
          msg.id === aiMessageId
            ? { ...msg, metadata: { ...msg.metadata, streaming: false, agentPlan: currentAgentPlan || undefined } }
            : msg
        ));
      }
      setIsTyping(false);

    } catch (error: any) {
      setIsTyping(false);
      if (error.name === 'AbortError') {
        console.log('🛑 Streaming request cancelled');
        return;
      }
      console.error('❌ Streaming failed:', error);
      const errorMessage: Message = {
        id: aiMessageId,
        content: `Error: ${error.message}`,
        role: 'assistant',
        timestamp: new Date(),
        metadata: { error: true }
      };
      if (!messageAdded) {
        setMessages(prev => [...prev, errorMessage]);
      } else {
        setMessages(prev => prev.map(msg =>
          msg.id === aiMessageId ? errorMessage : msg
        ));
      }
    }
  }, [chatId, userId, llmMode]);

  // Non-streaming message sender (fallback for file uploads)
  const sendMessageBatch = useCallback(async (
    content: string,
    files?: UploadedFile[],
    options?: ChatOptions
  ) => {
    if (!chatId || !userId) {
      console.error('❌ Cannot send message: chatId or userId missing');
      return;
    }

    const token = localStorage.getItem('simorgh_token');
    if (!token) {
      console.error('❌ No auth token found');
      const errorMessage: Message = {
        id: (Date.now() + 1).toString(),
        content: 'Authentication required. Please log in again.',
        role: 'assistant',
        timestamp: new Date(),
        metadata: { error: true }
      };
      setMessages(prev => [...prev, errorMessage]);
      return;
    }

    // Cancel any ongoing request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    setIsTyping(true);

    try {
      let response;

      if (files && files.length > 0 && files[0].file) {
        // Use FormData for file uploads - still use v1 for now (v2 document upload is separate)
        console.log('📎 Sending with file attachment (v1 API):', files[0].name);
        const formData = new FormData();
        formData.append('chat_id', chatId);
        formData.append('user_id', userId);
        formData.append('content', content);
        if (llmMode) {
          formData.append('llm_mode', llmMode);
        }
        formData.append('use_graph_context', String(options?.useGraphContext !== false));
        formData.append('grounded_mode', String(options?.groundedMode || false));
        formData.append('file', files[0].file);

        response = await axios.post(`${API_BASE}/chat/send`, formData, {
          headers: {
            'Content-Type': 'multipart/form-data',
            'Authorization': `Bearer ${token}`
          },
          signal: abortControllerRef.current?.signal
        });
      } else {
        // Use v2 API endpoint with chatbot_core
        console.log('📤 Sending message via v2 API (batch):', content);
        response = await axios.post(`${API_V2_CHAT}/${chatId}/message`, {
          user_id: userId,
          message: content,  // v2 uses 'message' instead of 'content'
          use_tools: options?.useGraphContext !== false,
          stream: false
        }, {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          signal: abortControllerRef.current?.signal
        });
      }

      const data = response.data;

      // Handle v2 response format (content instead of response)
      const responseContent = data.content || data.response;

      const aiMessage: Message = {
        id: (Date.now() + 1).toString(),
        content: responseContent,
        role: 'assistant',
        timestamp: new Date(),
        metadata: {
          llm_mode: data.mode || data.llm_mode,
          context_used: data.sources?.length > 0 || data.context_used,
          cached_response: data.cached_response,
          tokens: data.tokens_used || data.tokens,
          sources: data.sources,  // v2 provides sources
          // Surfaces priority-2's fit_history telemetry so the chat
          // input's TokenUsageRing can paint live context-window usage.
          token_budget: data.token_budget,
        }
      };

      setMessages(prev => [...prev, aiMessage]);
      setIsTyping(false);

      if (data.spec_task_id && onSpecTaskCreated) {
        onSpecTaskCreated(data.spec_task_id);
      }

      showNotification('Response Ready!', data.response);
      console.log('✅ Message sent successfully (batch mode)');

    } catch (error: any) {
      if (axios.isCancel(error) || error.name === 'CanceledError') {
        console.log('🛑 Request cancelled by user');
        setIsTyping(false);
        return;
      }

      console.error('❌ Send message failed:', error);
      setIsTyping(false);

      let errorContent = 'Failed to connect to server. Please try again.';
      if (error.response?.data?.detail) {
        const detail = error.response.data.detail;
        if (typeof detail === 'object' && detail.message) {
          errorContent = `❌ ${detail.error || 'Error'}: ${detail.message}`;
        } else if (typeof detail === 'string') {
          errorContent = detail;
        }
      }

      const errorMessage: Message = {
        id: (Date.now() + 1).toString(),
        content: errorContent,
        role: 'assistant',
        timestamp: new Date(),
        metadata: { error: true }
      };

      setMessages(prev => [...prev, errorMessage]);
    }
  }, [chatId, userId, llmMode, messages, onSpecTaskCreated]);

  // Main sendMessage function - uses streaming by default
  const sendMessage = async (
    content: string,
    files?: UploadedFile[],
    options?: ChatOptions
  ) => {
    if (!chatId || !userId) {
      console.log(chatId);
      console.log(userId);
      console.error('❌ Cannot send message: chatId or userId missing');
      return;
    }

    console.log('📤 Sending message:', content);
    console.log('🎯 Chat ID:', chatId);
    console.log('🤖 LLM Mode:', options?.llmMode || llmMode || 'default');

    const userMessage: Message = {
      id: Date.now().toString(),
      content,
      role: 'user',
      timestamp: new Date(),
      files
    };

    setMessages(prev => [...prev, userMessage]);

    // Use streaming unless disabled or files are attached
    const useStreaming = options?.useStreaming !== false && (!files || files.length === 0);

    if (useStreaming) {
      await sendMessageStreaming(content, options);
    } else {
      await sendMessageBatch(content, files, options);
    }

    // Auto-generate chat title if this is the first message
    if (messages.length === 0) {
      try {
        const token = localStorage.getItem('simorgh_token');
        if (token) {
          console.log('🎯 Generating chat title for first message...');
          const formData = new FormData();
          formData.append('first_message', content);

          const titleResponse = await axios.post(`${API_BASE}/chats/${chatId}/generate-title`, formData, {
            headers: {
              'Authorization': `Bearer ${token}`
            }
          });

          const generatedTitle = titleResponse.data.title;
          console.log('✅ Chat title generated:', generatedTitle);

          if (onTitleGenerated && generatedTitle) {
            onTitleGenerated(chatId, generatedTitle);
          }
        }
      } catch (titleError) {
        console.warn('⚠️ Failed to generate chat title:', titleError);
      }
    }
  };

  const toggleLlmMode = () => {
    const newMode = llmMode === 'online' ? 'offline' : 'online';
    setLlmMode(newMode);
    localStorage.setItem('llm_mode', newMode);
    console.log('🔄 LLM mode changed to:', newMode);
  };

  const setLlmModeExplicit = (mode: 'online' | 'offline') => {
    setLlmMode(mode);
    localStorage.setItem('llm_mode', mode);
    console.log('🔄 LLM mode set to:', mode);
  };

  const regenerateResponse = async (assistantMessageId: string) => {
    // Find the assistant message
    const assistantMsgIndex = messages.findIndex(msg => msg.id === assistantMessageId);
    if (assistantMsgIndex === -1 || messages[assistantMsgIndex].role !== 'assistant') {
      console.error('❌ Assistant message not found');
      return;
    }

    // Find the preceding user message
    let userMsgIndex = assistantMsgIndex - 1;
    while (userMsgIndex >= 0 && messages[userMsgIndex].role !== 'user') {
      userMsgIndex--;
    }

    if (userMsgIndex === -1) {
      console.error('❌ No user message found before assistant message');
      return;
    }

    const userMessage = messages[userMsgIndex];
    const assistantMessage = messages[assistantMsgIndex];

    // Store current response as a version
    const currentVersion: Message['versions'] = assistantMessage.versions || [];
    currentVersion.push({
      id: Date.now().toString(),
      content: assistantMessage.content,
      timestamp: assistantMessage.timestamp,
      metadata: assistantMessage.metadata
    });

    // Update the message to show it's regenerating
    setMessages(prev => {
      const updated = [...prev];
      updated[assistantMsgIndex] = {
        ...assistantMessage,
        versions: currentVersion,
        refreshCount: (assistantMessage.refreshCount || 0) + 1
      };
      return updated;
    });

    setIsTyping(true);

    try {
      const token = localStorage.getItem('simorgh_token');
      if (!token) {
        console.error('❌ No auth token found');
        setIsTyping(false);
        return;
      }

      // Re-send the user message content
      const conversationHistory = messages.slice(0, userMsgIndex).slice(-10).map(msg => ({
        role: msg.role,
        content: msg.content
      }));

      let response;

      if (userMessage.files && userMessage.files.length > 0 && userMessage.files[0].file) {
        // Use v1 for file attachments
        const formData = new FormData();
        formData.append('chat_id', chatId!);
        formData.append('user_id', userId!);
        formData.append('content', userMessage.content);
        if (llmMode) formData.append('llm_mode', llmMode);
        formData.append('use_graph_context', 'true');
        formData.append('file', userMessage.files[0].file);

        response = await axios.post(`${API_BASE}/chat/send`, formData, {
          headers: {
            'Content-Type': 'multipart/form-data',
            'Authorization': `Bearer ${token}`
          }
        });
      } else {
        // Use v2 API for regeneration
        response = await axios.post(`${API_V2_CHAT}/${chatId}/message`, {
          user_id: userId,
          message: userMessage.content,
          use_tools: true,
          stream: false
        }, {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          }
        });
      }

      const data = response.data;
      const responseContent = data.content || data.response;

      // Update the assistant message with new content
      setMessages(prev => {
        const updated = [...prev];
        updated[assistantMsgIndex] = {
          ...updated[assistantMsgIndex],
          content: responseContent,
          timestamp: new Date(),
          metadata: {
            llm_mode: data.mode || data.llm_mode,
            context_used: data.sources?.length > 0 || data.context_used,
            cached_response: data.cached_response,
            tokens: data.tokens_used || data.tokens,
            sources: data.sources,
            token_budget: data.token_budget,
          },
          currentVersionIndex: currentVersion.length
        };
        return updated;
      });

      setIsTyping(false);
      console.log('✅ Response regenerated successfully');

    } catch (error: any) {
      console.error('❌ Regenerate failed:', error);
      setIsTyping(false);

      let errorContent = 'Failed to regenerate response. Please try again.';
      if (error.response?.data?.detail) {
        const detail = error.response.data.detail;
        if (typeof detail === 'object' && detail.message) {
          errorContent = `❌ ${detail.error || 'Error'}: ${detail.message}`;
        } else if (typeof detail === 'string') {
          errorContent = detail;
        }
      }

      // Restore the original message on error
      setMessages(prev => {
        const updated = [...prev];
        updated[assistantMsgIndex] = {
          ...assistantMessage,
          content: errorContent,
          metadata: { error: true }
        };
        return updated;
      });
    }
  };

  const updateMessageReaction = (messageId: string, reaction: 'like' | 'dislike' | 'none') => {
    setMessages(prev => prev.map(msg => {
      if (msg.id === messageId) {
        return {
          ...msg,
          liked: reaction === 'like',
          disliked: reaction === 'dislike'
        };
      }
      return msg;
    }));
  };

  const switchVersion = (messageId: string, versionIndex: number) => {
    setMessages(prev => prev.map(msg => {
      if (msg.id === messageId && msg.versions && msg.versions[versionIndex]) {
        const currentContent = { content: msg.content, timestamp: msg.timestamp, metadata: msg.metadata };
        const newVersion = msg.versions[versionIndex];

        // Swap current with selected version
        const updatedVersions = [...msg.versions];
        updatedVersions[versionIndex] = {
          id: msg.id,
          content: currentContent.content,
          timestamp: currentContent.timestamp,
          metadata: currentContent.metadata
        };

        return {
          ...msg,
          content: newVersion.content,
          timestamp: newVersion.timestamp,
          metadata: newVersion.metadata,
          versions: updatedVersions,
          currentVersionIndex: versionIndex
        };
      }
      return msg;
    }));
  };

  const cancelGeneration = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
      setIsTyping(false);
      console.log('🛑 Generation cancelled');
    }
  };

  const editMessage = (messageId: string, newContent: string, newFiles?: UploadedFile[]) => {
    // Find the message to edit
    const messageIndex = messages.findIndex(msg => msg.id === messageId);
    if (messageIndex === -1 || messages[messageIndex].role !== 'user') {
      console.error('❌ User message not found');
      return;
    }

    // Cancel any ongoing generation
    cancelGeneration();

    // Remove all messages after the edited message
    const updatedMessages = messages.slice(0, messageIndex);
    setMessages(updatedMessages);

    // Send the edited message
    sendMessage(newContent, newFiles);
  };

  return {
    messages,
    isTyping,
    sendMessage,
    llmMode,
    toggleLlmMode,
    setLlmMode: setLlmModeExplicit,
    regenerateResponse,
    updateMessageReaction,
    switchVersion,
    cancelGeneration,
    editMessage
  };
}

// Browser Notification Helper
function showNotification(title: string, body: string) {
  const notifEnabled = localStorage.getItem('notifications_enabled') === 'true';

  console.log('🔔 Notification check:', {
    enabled: notifEnabled,
    permission: Notification.permission,
    pageVisible: document.visibilityState === 'visible'
  });

  if (!notifEnabled || Notification.permission !== 'granted') {
    console.log('⏭️ Notifications disabled or not granted');
    return;
  }

  // Only send notification if page is not focused
  if (document.visibilityState === 'visible' && document.hasFocus()) {
    console.log('⏭️ Page is focused, skipping notification');
    return;
  }

  try {
    const notification = new Notification(title, {
      body: body.slice(0, 100) + (body.length > 100 ? '...' : ''),
      icon: '/favicon.ico',
      badge: '/favicon.ico',
      tag: 'simorgh-chat',
      requireInteraction: false,
      silent: false
    });

    notification.onclick = () => {
      window.focus();
      notification.close();
    };

    setTimeout(() => notification.close(), 5000);

    const audio = new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=');
    audio.play().catch(() => { });

    console.log('✅ Notification shown');
  } catch (error) {
    console.error('❌ Notification error:', error);
  }
}
