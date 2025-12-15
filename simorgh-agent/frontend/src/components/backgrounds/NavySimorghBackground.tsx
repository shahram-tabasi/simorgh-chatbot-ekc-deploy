import React, { useEffect, useRef } from 'react';

export function NavySimorghBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const simorghImageRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    // Load Simorgh SVG image
    const img = new Image();
    img.src = '/favicon.svg'; // SVG is in public folder
    img.onload = () => {
      simorghImageRef.current = img;
    };
    img.onerror = (err) => {
      console.error('Failed to load SVG image:', err);
    };

    // Background stars
    const stars: Array<{
      x: number;
      y: number;
      size: number;
      opacity: number;
      speed: number;
      baseOpacity: number;
    }> = [];

    for (let i = 0; i < 100; i++) {
      const baseOpacity = Math.random() * 0.5 + 0.3;
      stars.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        size: Math.random() * 1.5 + 0.5,
        opacity: baseOpacity,
        speed: Math.random() * 0.01 + 0.005,
        baseOpacity: baseOpacity
      });
    }

    // Twinkling stars (smaller, faster)
    const twinklingStars: Array<{
      x: number;
      y: number;
      size: number;
      opacity: number;
      speed: number;
      phase: number;
    }> = [];

    for (let i = 0; i < 50; i++) {
      twinklingStars.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        size: Math.random() * 1 + 0.3,
        opacity: Math.random() * 0.7 + 0.3,
        speed: Math.random() * 0.03 + 0.01,
        phase: Math.random() * Math.PI * 2
      });
    }

    function animate() {
      if (!ctx || !canvas) return;

      // Clear canvas
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Draw deep navy gradient background
      const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
      gradient.addColorStop(0, '#0a0f1e'); // Deep navy blue
      gradient.addColorStop(0.5, '#0f172a'); // Dark blue
      gradient.addColorStop(1, '#1a2b3d'); // Navy with purple tint

      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Draw background stars
      stars.forEach(star => {
        // Gentle pulsing effect
        star.opacity += star.speed;
        if (star.opacity > star.baseOpacity + 0.2 || star.opacity < star.baseOpacity - 0.2) {
          star.speed = -star.speed;
        }

        ctx.beginPath();
        ctx.arc(star.x, star.y, star.size, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 255, 255, ${star.opacity * 0.4})`;
        ctx.fill();
      });

      // Draw twinkling stars
      twinklingStars.forEach(star => {
        // More pronounced twinkling effect
        star.opacity = 0.3 + 0.5 * Math.abs(Math.sin(Date.now() * 0.001 + star.phase));

        ctx.beginPath();
        ctx.arc(star.x, star.y, star.size, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 255, 255, ${star.opacity})`;
        ctx.fill();

        // Add a subtle glow
        ctx.beginPath();
        ctx.arc(star.x, star.y, star.size + 1, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 255, 255, ${star.opacity * 0.2})`;
        ctx.fill();
      });

      // Draw Simorgh constellation from SVG
      if (simorghImageRef.current) {
        const img = simorghImageRef.current;
        const scale = 0.3; // Adjust scale as needed
        const width = img.naturalWidth * scale;
        const height = img.naturalHeight * scale;
        const x = (canvas.width - width) / 2;
        const y = (canvas.height - height) / 2;

        // Save context state
        ctx.save();

        // Create a subtle pulsing effect for the constellation
        const pulse = 0.7 + 0.3 * Math.sin(Date.now() * 0.001);

        // Set global alpha for fading effect
        ctx.globalAlpha = 0.6 * pulse;

        // Draw the SVG
        ctx.drawImage(img, x, y, width, height);

        // Restore context
        ctx.restore();

        // Add a very subtle glow around the constellation
        ctx.save();
        ctx.globalAlpha = 0.1 * pulse;
        ctx.filter = 'blur(10px)';
        ctx.drawImage(img, x, y, width, height);
        ctx.restore();
      }

      requestAnimationFrame(animate);
    }

    animate();

    const handleResize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;

      // Update star positions on resize
      stars.forEach(star => {
        star.x = Math.random() * canvas.width;
        star.y = Math.random() * canvas.height;
      });

      twinklingStars.forEach(star => {
        star.x = Math.random() * canvas.width;
        star.y = Math.random() * canvas.height;
      });
    };

    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0 pointer-events-none z-0"
    />
  );
}