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

  // Load user's LLM preference
  useEffect(() => {
    const savedMode = localStorage.getItem('llm_mode') as 'online' | 'offline' | null;
    if (savedMode) {
      setLlmMode(savedMode);
    }
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
      setIsTyping(false);

      const errorMessage: Message = {
        id: (Date.now() + 1).toString(),
        content: error.response?.data?.detail || 'Failed to connect to server. Please try again.',
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
