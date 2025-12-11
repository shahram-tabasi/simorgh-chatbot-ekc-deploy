import React, { useEffect, useRef } from 'react';

export function NavySimorghBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    // Simorgh constellation points (simplified bird shape)
    const simorghConstellation = [
      // Head
      { x: 0.5, y: 0.3 },
      { x: 0.52, y: 0.28 },
      { x: 0.54, y: 0.3 },
      // Body
      { x: 0.5, y: 0.35 },
      { x: 0.48, y: 0.4 },
      { x: 0.52, y: 0.4 },
      // Wings
      { x: 0.42, y: 0.38 },
      { x: 0.35, y: 0.36 },
      { x: 0.58, y: 0.38 },
      { x: 0.65, y: 0.36 },
      // Tail
      { x: 0.5, y: 0.45 },
      { x: 0.48, y: 0.5 },
      { x: 0.52, y: 0.5 }
    ].map(p => ({
      x: p.x * canvas.width,
      y: p.y * canvas.height,
      opacity: Math.random() * 0.5 + 0.5,
      speed: Math.random() * 0.01 + 0.005
    }));

    // Background stars
    const stars: Array<{ x: number; y: number; size: number; opacity: number }> = [];
    for (let i = 0; i < 100; i++) {
      stars.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        size: Math.random() * 1.5 + 0.5,
        opacity: Math.random() * 0.5 + 0.3
      });
    }

    function animate() {
      if (!ctx || !canvas) return;

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Draw background stars
      stars.forEach(star => {
        ctx.beginPath();
        ctx.arc(star.x, star.y, star.size, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 255, 255, ${star.opacity * 0.4})`;
        ctx.fill();
      });

      // Draw Simorgh constellation
      simorghConstellation.forEach((point, i) => {
        point.opacity += point.speed;
        if (point.opacity > 1 || point.opacity < 0.3) {
          point.speed = -point.speed;
        }

        // Draw star
        ctx.beginPath();
        ctx.arc(point.x, point.y, 3, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 220, 150, ${point.opacity})`;
        ctx.fill();

        // Draw connecting lines
        if (i > 0) {
          const prev = simorghConstellation[i - 1];
          ctx.beginPath();
          ctx.moveTo(prev.x, prev.y);
          ctx.lineTo(point.x, point.y);
          ctx.strokeStyle = `rgba(255, 220, 150, ${(point.opacity + prev.opacity) / 4})`;
          ctx.lineWidth = 1;
          ctx.stroke();
        }
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
    <div className="fixed inset-0 pointer-events-none" style={{ background: '#0b1d33' }}>
      <canvas ref={canvasRef} className="absolute inset-0" />
    </div>
  );
}
