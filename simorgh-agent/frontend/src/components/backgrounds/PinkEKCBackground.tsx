import React, { useEffect, useRef } from 'react';

export function PinkEKCBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    // Create soft twinkling stars
    const stars: Array<{ x: number; y: number; size: number; opacity: number; speed: number }> = [];

    for (let i = 0; i < 50; i++) {
      stars.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        size: Math.random() * 2 + 0.5,
        opacity: Math.random(),
        speed: Math.random() * 0.02 + 0.01
      });
    }

    function animate() {
      if (!ctx || !canvas) return;

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Draw twinkling stars
      stars.forEach(star => {
        star.opacity += star.speed;
        if (star.opacity > 1 || star.opacity < 0.2) {
          star.speed = -star.speed;
        }

        ctx.beginPath();
        ctx.arc(star.x, star.y, star.size, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 255, 255, ${star.opacity * 0.6})`;
        ctx.fill();
      });

      requestAnimationFrame(animate);
    }

    animate();

    const handleResize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return (
    <div className="fixed inset-0 pointer-events-none" style={{ background: '#fef5f8' }}>
      <canvas ref={canvasRef} className="absolute inset-0" />

      {/* Soft gradient overlay for better UI contrast */}
      <div
        className="absolute inset-0"
        style={{
          background: 'radial-gradient(ellipse at center, rgba(249, 223, 232, 0.3) 0%, transparent 70%)'
        }}
      />

      {/* EKC Text */}
      <div className="absolute inset-0 flex items-center justify-center">
        <div
          className="text-9xl font-bold opacity-10 select-none"
          style={{ color: '#c28ba0' }}
        >
          EKC
        </div>
      </div>
    </div>
  );
}
