import React from 'react';

export const FrontendAccessButton: React.FC = () => {
  const handleClick = () => {
    window.open('https://your-frontend-url.com', '_blank');
  };

  return (
    <button
      onClick={handleClick}
      style={{
        padding: '10px 20px',
        backgroundColor: '#10b981',
        color: 'white',
        border: 'none',
        borderRadius: '8px',
        fontWeight: 'bold',
        cursor: 'pointer',
        boxShadow: '0 4px 12px rgba(16, 185, 129, 0.3)',
      }}
    >
      ورود به فرانت‌اند
    </button>
  );
};