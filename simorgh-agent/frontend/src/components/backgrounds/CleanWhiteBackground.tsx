import React from 'react';

export function CleanWhiteBackground() {
  return (
    <div
      className="fixed inset-0 pointer-events-none"
      style={{ background: '#ffffff' }}
    >
      {/* Subtle dot pattern */}
      <div
        className="absolute inset-0 opacity-20"
        style={{
          backgroundImage: 'radial-gradient(circle, #00000008 1px, transparent 1px)',
          backgroundSize: '20px 20px'
        }}
      />

      {/* Soft gradient overlay */}
      <div
        className="absolute inset-0"
        style={{
          background: 'radial-gradient(ellipse at top, rgba(99,102,241,0.03) 0%, transparent 50%)'
        }}
      />
    </div>
  );
}
