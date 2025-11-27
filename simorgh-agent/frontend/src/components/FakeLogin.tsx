// src/components/FakeLogin.tsx  (بعداً حذفش کن)
import React, { useState } from 'react';

export const FakeLogin: React.FC<{ onLogin: (user: any) => void }> = ({ onLogin }) => {
  const [name, setName] = useState('حسن ولیخانی');

  const login = () => {
    const fakeUser = {
      userId: 'user_123',
      userEmail: 'h.valikhani@example.com',
      name,
      jwt: 'fake-jwt-eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.xxxxx',
    };
    localStorage.setItem('fakeUser', JSON.stringify(fakeUser));
    onLogin(fakeUser);
  };

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      background: 'rgba(0,0,0,0.9)', zIndex: 9999,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexDirection: 'column', color: 'white', fontFamily: 'sans-serif'
    }}>
      <h1>ورود آزمایشی (سوری)</h1>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        style={{ padding: 12, fontSize: 16, margin: '20px 0', width: 300 }}
        placeholder="نام شما"
      />
      <button onClick={login} style={{
        padding: '14px 40px', fontSize: 18, background: '#10b981',
        color: 'white', border: 'none', borderRadius: 8, cursor: 'pointer'
      }}>
        ورود به چت‌بات
      </button>
      <p style={{ marginTop: 20, fontSize: 12, opacity: 0.7 }}>
        این صفحه فقط برای تست است — بعداً حذف میشه
      </p>
    </div>
  );
};