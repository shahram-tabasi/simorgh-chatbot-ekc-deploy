// src/hooks/useChatWithRedis.ts
import { useState, useEffect, useRef } from 'react';
import redis from '../services/redis';
import { apiService } from '../services/api';
import { ChatMessage } from '../types';

interface SavedChat {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: string;
}

export const useChatWithRedis = () => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [savedChats, setSavedChats] = useState<SavedChat[]>([]);
  const [currentChatId, setCurrentChatId] = useState<string | null>(null);
  const [notificationEnabled, setNotificationEnabled] = useState(false);
  const userRef = useRef<any>(null);

  // بارگذاری کاربر سوری
  useEffect(() => {
    const fake = localStorage.getItem('fakeUser');
    if (fake) userRef.current = JSON.parse(fake);
  }, []);

  // فعال‌سازی نوتیفیکیشن
  const enableNotifications = () => {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().then(perm => {
        if (perm === 'granted') {
          setNotificationEnabled(true);
          redis.set(`notif:${userRef.current?.userId}`, 'enabled');
          new Notification('نوتیفیکیشن فعال شد');
        }
      });
    }
  };

  // ارسال پیام + ذخیره خودکار
  const sendMessage = async (content: string) => {
    if (!content.trim() || !userRef.current) return;

    const userMessage: ChatMessage = { role: 'user', content };
    const newMessages = [...messages, userMessage];
    setMessages([...newMessages, { role: 'assistant', content: 'در حال فکر...' }]);

    // ذخیره موقت در ردیس
    const tempId = Date.now().toString();
    setCurrentChatId(tempId);

    try {
      const response = await apiService.sendMessage(content, {
        projectId: 'test-project',
        oeNumber: 'OE123',
      });

      const assistantMessage: ChatMessage = { role: 'assistant', content: response.response };
      const finalMessages = [...newMessages, assistantMessage];
      setMessages(finalMessages);

      // ذخیره نهایی در ردیس
      const chat: SavedChat = {
        id: tempId,
        title: content.slice(0, 40) + (content.length > 40 ? '...' : ''),
        messages: finalMessages,
        createdAt: new Date().toISOString(),
      };

      await redis.set(`chat:${userRef.current.userId}:${tempId}`, JSON.stringify(chat));
      await redis.lpush(`chats:${userRef.current.userId}`, tempId);

      // نوتیفیکیشن + صدا
      if (notificationEnabled || Notification.permission === 'granted') {
        new Notification('پاسخ آماده شد!', { body: 'چت‌بات پاسخ داد' });
        const audio = new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=');
        audio.play();
      }

      loadSavedChats();
    } catch (err) {
      setMessages([...newMessages, { role: 'assistant', content: 'خطا در ارتباط با سرور' }]);
    }
  };

  // بارگذاری چت‌های قبلی
  const loadSavedChats = async () => {
    if (!userRef.current) return;
    const ids = await redis.lrange(`chats:${userRef.current.userId}`, 0, -1);
    const chats = await Promise.all(
      ids.map(async id => {
        const data = await redis.get(`chat:${userRef.current.userId}:${id}`);
        return data ? JSON.parse(data) : null;
      })
    );
    setSavedChats(chats.filter(Boolean).reverse());
  };

  // چت جدید
  const startNewChat = () => {
    setMessages([]);
    setCurrentChatId(null);
  };

  // بارگذاری چت قدیمی
  const loadChat = (chat: SavedChat) => {
    setMessages(chat.messages);
    setCurrentChatId(chat.id);
  };

  useEffect(() => {
    if (userRef.current) loadSavedChats();
  }, []);

  return {
    messages,
    savedChats,
    currentChatId,
    sendMessage,
    startNewChat,
    loadChat,
    enableNotifications,
    notificationEnabled,
  };
};