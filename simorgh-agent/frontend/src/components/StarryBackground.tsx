import React from 'react';
export function StarryBackground() {
  return <div className="fixed inset-0 overflow-hidden pointer-events-none">
      {/* Base gradient */}
      <div className="absolute inset-0 bg-gradient-to-b from-[#0a0e27] via-[#1a1f3a] to-[#0f1420]" />

      {/* Stars layers */}
      <div className="stars-layer-1" />
      <div className="stars-layer-2" />
      <div className="stars-layer-3" />

      {/* Shooting stars */}
      <div className="shooting-star" style={{
      top: '20%',
      left: '10%',
      animationDelay: '0s'
    }} />
      <div className="shooting-star" style={{
      top: '40%',
      left: '60%',
      animationDelay: '3s'
    }} />
      <div className="shooting-star" style={{
      top: '60%',
      left: '30%',
      animationDelay: '6s'
    }} />
      <div className="shooting-star" style={{
      top: '80%',
      left: '70%',
      animationDelay: '9s'
    }} />

      {/* Nebula glow */}
      <div className="absolute top-1/4 right-1/4 w-96 h-96 bg-purple-500/10 rounded-full blur-3xl" />
      <div className="absolute bottom-1/4 left-1/4 w-96 h-96 bg-blue-500/10 rounded-full blur-3xl" />
    </div>;
}