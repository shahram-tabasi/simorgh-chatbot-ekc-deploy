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

    // Simorgh constellation points (Persian mythological bird shape)
    const simorghConstellation = [
      // Beak and Head
      { x: 0.52, y: 0.25 },  // Beak tip
      { x: 0.51, y: 0.27 },  // Upper beak
      { x: 0.50, y: 0.29 },  // Head center
      { x: 0.49, y: 0.31 },  // Neck

      // Body
      { x: 0.48, y: 0.35 },  // Upper body
      { x: 0.47, y: 0.40 },  // Mid body
      { x: 0.48, y: 0.45 },  // Lower body

      // Left Wing (extended)
      { x: 0.45, y: 0.37 },  // Wing joint
      { x: 0.40, y: 0.36 },  // Mid wing
      { x: 0.35, y: 0.38 },  // Wing tip outer
      { x: 0.32, y: 0.40 },  // Wing feather 1
      { x: 0.30, y: 0.43 },  // Wing feather 2

      // Back to body for right wing
      { x: 0.47, y: 0.40 },  // Return to body center

      // Right Wing (extended)
      { x: 0.51, y: 0.37 },  // Wing joint
      { x: 0.56, y: 0.36 },  // Mid wing
      { x: 0.61, y: 0.38 },  // Wing tip outer
      { x: 0.64, y: 0.40 },  // Wing feather 1
      { x: 0.66, y: 0.43 },  // Wing feather 2

      // Back to body for tail
      { x: 0.48, y: 0.45 },  // Return to body

      // Tail Feathers (elaborate)
      { x: 0.47, y: 0.50 },  // Tail start left
      { x: 0.45, y: 0.55 },  // Left tail feather
      { x: 0.44, y: 0.60 },  // Left tail feather tip
      { x: 0.48, y: 0.50 },  // Tail center
      { x: 0.48, y: 0.56 },  // Center tail feather
      { x: 0.48, y: 0.62 },  // Center tail feather tip
      { x: 0.49, y: 0.50 },  // Tail start right
      { x: 0.51, y: 0.55 },  // Right tail feather
      { x: 0.52, y: 0.60 }   // Right tail feather tip
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
