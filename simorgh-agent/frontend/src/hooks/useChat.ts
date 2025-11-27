// src/hooks/useChat.ts
import { useState, useEffect, useRef } from 'react';
import { Message, UploadedFile } from '../types';

export function useChat(initialMessages: Message[] = [], chatId?: string | null) {
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [isTyping, setIsTyping] = useState(false);
  const prevChatIdRef = useRef<string | null>(null);

  // CRITICAL: Reset messages when chatId changes (new chat selected)
  useEffect(() => {
    // فقط وقتی chatId واقعاً عوض شده باشه
    if (chatId !== prevChatIdRef.current) {
      console.log('🔄 Chat switched - ID changed from', prevChatIdRef.current, 'to', chatId);
      console.log('📝 Loading messages:', initialMessages.length);
      
      setMessages(initialMessages);
      setIsTyping(false);
      prevChatIdRef.current = chatId || null;
    }
  }, [chatId, initialMessages]);

  const sendMessage = async (content: string, files?: UploadedFile[]) => {
    console.log('📤 Sending message:', content);
    
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
      // TODO: Replace with real API call
      // const response = await apiService.sendMessage(content, files);
      
      // Simulate AI response
      setTimeout(() => {
        const aiMessage: Message = {
          id: (Date.now() + 1).toString(),
          content: 'This is a sample response from AI. Real responses will come from the backend.',
          role: 'assistant',
          timestamp: new Date()
        };

        setMessages(prev => [...prev, aiMessage]);
        setIsTyping(false);

        // Browser Notification
        showNotification('Response Ready!', aiMessage.content);
        
        console.log('✅ Message sent successfully');
      }, 1500);

    } catch (error) {
      console.error('❌ Send message failed:', error);
      setIsTyping(false);
      
      const errorMessage: Message = {
        id: (Date.now() + 1).toString(),
        content: 'Failed to connect to server. Please try again.',
        role: 'assistant',
        timestamp: new Date()
      };
      
      setMessages(prev => [...prev, errorMessage]);
    }
  };

  return {
    messages,
    isTyping,
    sendMessage
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

  // فقط اگر صفحه فوکوس نداره نوتیفیکیشن بفرست
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
    audio.play().catch(() => {});
    
    console.log('✅ Notification shown');
  } catch (error) {
    console.error('❌ Notification error:', error);
  }
}