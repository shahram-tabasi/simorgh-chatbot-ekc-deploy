// src/hooks/useChat.ts
import { useState, useEffect, useRef, useCallback } from 'react';
import { Message, UploadedFile } from '../types';
import axios from 'axios';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

export interface ChatOptions {
  llmMode?: 'online' | 'offline' | null; // null = use default
  useGraphContext?: boolean;
  useStreaming?: boolean; // Enable streaming responses (default: true)
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
        // اگر هیچی نبود یا مقدار اشتباه بود → پیش‌فرض رو بذار online
        setLlmMode('online');
        localStorage.setItem('llm_mode', 'online');
        console.log('Set default LLM mode: online');
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

  // Reset messages when chatId changes OR when initialMessages updates (after async load)
  useEffect(() => {
    const chatIdChanged = chatId !== prevChatIdRef.current;

    if (chatIdChanged) {
      console.log('🔄 Chat switched - ID changed from', prevChatIdRef.current, 'to', chatId);
      prevChatIdRef.current = chatId || null;
    }

    // Update messages whenever initialMessages changes (including async loads)
    console.log('📝 Loading messages:', initialMessages.length);
    setMessages(initialMessages);

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
          use_graph_context: options?.useGraphContext !== false
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
                setMessages(prev => [...prev, errorMessage]);
                return;
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
                    metadata: { streaming: true }
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
                          streaming: false
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
          metadata: { llm_mode: finalLlmMode, context_used: contextUsed, streaming: false }
        };
        setMessages(prev => [...prev, aiMessage]);
      } else if (messageAdded) {
        setMessages(prev => prev.map(msg =>
          msg.id === aiMessageId
            ? { ...msg, metadata: { ...msg.metadata, streaming: false } }
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
        // Use FormData for file uploads
        console.log('📎 Sending with file attachment:', files[0].name);
        const formData = new FormData();
        formData.append('chat_id', chatId);
        formData.append('user_id', userId);
        formData.append('content', content);
        if (llmMode) {
          formData.append('llm_mode', llmMode);
        }
        formData.append('use_graph_context', String(options?.useGraphContext !== false));
        formData.append('file', files[0].file);

        response = await axios.post(`${API_BASE}/chat/send`, formData, {
          headers: {
            'Content-Type': 'multipart/form-data',
            'Authorization': `Bearer ${token}`
          },
          signal: abortControllerRef.current?.signal
        });
      } else {
        const conversationHistory = messages.slice(-10).map(msg => ({
          role: msg.role,
          content: msg.content
        }));

        response = await axios.post(`${API_BASE}/chat/send`, {
          chat_id: chatId,
          user_id: userId,
          content: content,
          conversation_history: conversationHistory,
          llm_mode: llmMode || undefined,
          use_graph_context: options?.useGraphContext !== false
        }, {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          signal: abortControllerRef.current?.signal
        });
      }

      const data = response.data;

      const aiMessage: Message = {
        id: (Date.now() + 1).toString(),
        content: data.response,
        role: 'assistant',
        timestamp: new Date(),
        metadata: {
          llm_mode: data.llm_mode,
          context_used: data.context_used,
          cached_response: data.cached_response,
          tokens: data.tokens
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
        response = await axios.post(`${API_BASE}/chat/send`, {
          chat_id: chatId,
          user_id: userId,
          content: userMessage.content,
          conversation_history: conversationHistory,
          llm_mode: llmMode || undefined,
          use_graph_context: true
        }, {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          }
        });
      }

      const data = response.data;

      // Update the assistant message with new content
      setMessages(prev => {
        const updated = [...prev];
        updated[assistantMsgIndex] = {
          ...updated[assistantMsgIndex],
          content: data.response,
          timestamp: new Date(),
          metadata: {
            llm_mode: data.llm_mode,
            context_used: data.context_used,
            cached_response: data.cached_response,
            tokens: data.tokens
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
