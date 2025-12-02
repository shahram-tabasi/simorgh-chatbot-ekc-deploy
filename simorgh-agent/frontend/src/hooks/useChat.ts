// src/hooks/useChat.ts
import { useState, useEffect, useRef } from 'react';
import { Message, UploadedFile } from '../types';
import axios from 'axios';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

export interface ChatOptions {
  llmMode?: 'online' | 'offline' | null; // null = use default
  useGraphContext?: boolean;
}

export function useChat(
  initialMessages: Message[] = [],
  chatId?: string | null,
  userId?: string,
  projectNumber?: string | null
) {
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [isTyping, setIsTyping] = useState(false);
  const [llmMode, setLlmMode] = useState<'online' | 'offline' | null>(null);
  const prevChatIdRef = useRef<string | null>(null);

  // Load user's LLM preference on mount and when localStorage changes
  useEffect(() => {
    const loadLlmMode = () => {
      const savedMode = localStorage.getItem('llm_mode') as 'online' | 'offline' | null;
      if (savedMode) {
        setLlmMode(savedMode);
        console.log('🔄 Loaded LLM mode from storage:', savedMode);
      } else {
        // Default to online if not set
        setLlmMode('online');
        localStorage.setItem('llm_mode', 'online');
        console.log('✅ Set default LLM mode: online');
      }
    };

    loadLlmMode();

    // Listen for storage changes from SettingsPanel
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === 'llm_mode' && e.newValue) {
        setLlmMode(e.newValue as 'online' | 'offline');
        console.log('🔄 LLM mode changed via storage event:', e.newValue);
      }
    };

    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, []);

  // Reset messages when chatId changes (new chat selected)
  useEffect(() => {
    if (chatId !== prevChatIdRef.current) {
      console.log('🔄 Chat switched - ID changed from', prevChatIdRef.current, 'to', chatId);
      console.log('📝 Loading messages:', initialMessages.length);

      setMessages(initialMessages);
      setIsTyping(false);
      prevChatIdRef.current = chatId || null;
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
    setIsTyping(true);

    try {
      // Get auth token
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
        setIsTyping(false);
        return;
      }

      // Call the /api/chat/send endpoint
      const response = await axios.post(`${API_BASE}/chat/send`, {
        chat_id: chatId,
        user_id: userId,
        content: content,
        llm_mode: options?.llmMode || llmMode,
        use_graph_context: options?.useGraphContext !== false
      }, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        }
      });

      const data = response.data;

      // Create AI message with metadata
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

      // Auto-generate chat title if this is the first message
      if (messages.length === 0) {
        try {
          console.log('🎯 Generating chat title for first message...');
          const formData = new FormData();
          formData.append('first_message', content);

          await axios.post(`${API_BASE}/chats/${chatId}/generate-title`, formData, {
            headers: {
              'Authorization': `Bearer ${token}`
            }
          });
          console.log('✅ Chat title generated successfully');
        } catch (titleError) {
          console.warn('⚠️ Failed to generate chat title:', titleError);
          // Non-critical error, continue anyway
        }
      }

      // Browser Notification
      showNotification('Response Ready!', data.response);

      console.log('✅ Message sent successfully');
      console.log('📊 Metadata:', {
        llm_mode: data.llm_mode,
        context_used: data.context_used,
        cached: data.cached_response,
        tokens: data.tokens
      });

    } catch (error: any) {
      console.error('❌ Send message failed:', error);
      console.error('Error details:', error.response?.data);
      setIsTyping(false);

      // Extract detailed error message
      let errorContent = 'Failed to connect to server. Please try again.';

      if (error.response?.data?.detail) {
        const detail = error.response.data.detail;

        // Check if detail is an object with structured error info
        if (typeof detail === 'object' && detail.message) {
          errorContent = `❌ ${detail.error || 'Error'}: ${detail.message}`;

          // Add technical details if available
          if (detail.technical_error) {
            errorContent += `\n\n🔧 Technical details: ${detail.technical_error}`;
          }

          // Add server info for offline errors
          if (detail.servers_tried) {
            errorContent += `\n\n🖥️ Servers tried:\n${detail.servers_tried.map((s: string) => `- ${s}`).join('\n')}`;
          }

          // Add model info for online errors
          if (detail.api_model) {
            errorContent += `\n\n🤖 Model: ${detail.api_model}`;
          }
        } else if (typeof detail === 'string') {
          errorContent = detail;
        }
      } else if (error.response?.data?.message) {
        errorContent = error.response.data.message;
      } else if (error.message) {
        errorContent = `Network error: ${error.message}`;
      }

      const errorMessage: Message = {
        id: (Date.now() + 1).toString(),
        content: errorContent,
        role: 'assistant',
        timestamp: new Date(),
        metadata: {
          error: true
        }
      };

      setMessages(prev => [...prev, errorMessage]);
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

  return {
    messages,
    isTyping,
    sendMessage,
    llmMode,
    toggleLlmMode,
    setLlmMode: setLlmModeExplicit
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
