import React from 'react';

export function CleanWhiteBackground() {
  return (
    <div
      className="fixed inset-0 pointer-events-none"
      style={{ background: '#f8f9fa' }}
    >
      {/* Subtle dot pattern with better contrast */}
      <div
        className="absolute inset-0 opacity-30"
        style={{
          backgroundImage: 'radial-gradient(circle, rgba(100, 100, 120, 0.08) 1px, transparent 1px)',
          backgroundSize: '24px 24px'
        }}
      />

      {/* Soft gradient overlay for depth */}
      <div
        className="absolute inset-0"
        style={{
          background: 'linear-gradient(135deg, rgba(99,102,241,0.02) 0%, rgba(168,85,247,0.02) 100%)'
        }}
      />

      {/* Subtle vignette for focus */}
      <div
        className="absolute inset-0"
        style={{
          background: 'radial-gradient(ellipse at center, transparent 0%, rgba(0,0,0,0.02) 100%)'
        }}
      />
    </div>
  );
}
