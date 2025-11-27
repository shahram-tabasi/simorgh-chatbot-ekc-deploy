// src/hooks/useFakeChat.ts
import { useState, useEffect } from 'react';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface SavedChat {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: string;
}

export const useFakeChat = () => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [savedChats, setSavedChats] = useState<SavedChat[]>([]);
  const [notificationEnabled, setNotificationEnabled] = useState(false);

  // فعال‌سازی نوتیفیکیشن
  const enableNotifications = () => {
    if ('Notification' in window && Notification.permission !== 'denied') {
      Notification.requestPermission().then(perm => {
        if (perm === 'granted') {
          setNotificationEnabled(true);
          new Notification('نوتیفیکیشن فعال شد!');
        }
      });
    }
  };

  // ارسال پیام با پاسخ جعلی
  const sendMessage = async (content: string) => {
    if (!content.trim()) return;

    const userMsg: ChatMessage = { role: 'user', content };
    
    // اضافه کردن پیام کاربر + placeholder دستیار
    setMessages(prev => [...prev, userMsg, { role: 'assistant', content: 'در حال تایپ...' }]);

    // شبیه‌سازی تاخیر
    await new Promise(resolve => setTimeout(resolve, 1500));

    const fakeResponses = [
      'سلام! چطور می‌تونم کمکت کنم؟',
      'این یه پاسخ آزمایشی از چت‌بات سیمرغ هست',
      'همه چیز عالی کار می‌کنه! ردیس، نوتیفیکیشن، ذخیره چت — همه فعاله',
      'شما الان در حالت تست هستید. وقتی بک‌اند وصل شد، این پیام‌ها واقعی میشن!',
      'عالیه که داری تست می‌کنی حسن جان!',
    ];
    const response = fakeResponses[Math.floor(Math.random() * fakeResponses.length)];

    // بروزرسانی آخرین پیام با پاسخ واقعی
    setMessages(prev => {
      const updated = [...prev];
      updated[updated.length - 1] = { role: 'assistant', content: response };
      return updated;
    });

    // ذخیره چت جدید (با تایپ دقیق)
    setSavedChats(prevChats => {
      const chatId = Date.now().toString();
      const finalMessages: ChatMessage[] = [
        ...messages.filter(m => m.role === 'user'), // فقط پیام‌های کاربر تا الان
        userMsg,
        { role: 'assistant', content: response }
      ];

      const newChat: SavedChat = {
        id: chatId,
        title: content.slice(0, 40) + (content.length > 40 ? '...' : ''),
        messages: finalMessages,
        createdAt: new Date().toISOString(),
      };

      const updated = [...prevChats, newChat];
      localStorage.setItem('fakeChats', JSON.stringify(updated));
      return updated;
    });

    // نوتیفیکیشن
    if (notificationEnabled) {
      new Notification('پاسخ آماده شد!', { body: 'چت‌بات پاسخ داد' });
      const audio = new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=');
      audio.play().catch(() => {});
    }
  };

  const startNewChat = () => {
    setMessages([]);
  };

  const loadChat = (chat: SavedChat) => {
    setMessages(chat.messages);
  };

  // بارگذاری چت‌های ذخیره شده
  useEffect(() => {
    const saved = localStorage.getItem('fakeChats');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        // اطمینان از نوع درست (TypeScript خوشحال میشه)
        if (Array.isArray(parsed)) {
          setSavedChats(parsed as SavedChat[]);
        }
      } catch (e) {
        console.error('خطا در خواندن چت‌ها', e);
      }
    }
  }, []);

  return {
    messages,
    savedChats,
    sendMessage,
    startNewChat,
    loadChat,
    enableNotifications,
    notificationEnabled,
  };
};