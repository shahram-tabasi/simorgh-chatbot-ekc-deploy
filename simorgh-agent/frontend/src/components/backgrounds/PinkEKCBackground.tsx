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
    
    // Create soft twinkling stars (BACKGROUND)
    const bgStars: Array<{ x: number; y: number; size: number; opacity: number; speed: number }> = [];
    for (let i = 0; i < 80; i++) {
      bgStars.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        size: Math.random() * 1.5 + 0.3,
        opacity: Math.random() * 0.5 + 0.3,
        speed: Math.random() * 0.015 + 0.005
      });
    }
    
    // EKC Stars (FOREGROUND - با opacity کمتر)
    const ekcStars: Array<{ x: number; y: number; size: number; opacity: number; speed: number }> = [];
    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;
    
    // موقعیت‌های EKC (با responsive positioning)
    const ekcPositions = [
      // حرف E
      { x: centerX - 200, y: centerY - 90 },
      { x: centerX - 200, y: centerY },
      { x: centerX - 200, y: centerY + 90 },
      { x: centerX - 80, y: centerY - 90 },
      { x: centerX - 80, y: centerY },
      { x: centerX - 80, y: centerY + 90 },
      
      // حرف K
      { x: centerX, y: centerY - 100 },
      { x: centerX, y: centerY },
      { x: centerX, y: centerY + 90 },
      { x: centerX + 70, y: centerY - 104 },
      { x: centerX + 70, y: centerY + 86 },
      
      // حرف C
      { x: centerX + 200, y: centerY - 90 },
      { x: centerX + 155, y: centerY - 70 },
      { x: centerX + 135, y: centerY - 30 },
      { x: centerX + 130, y: centerY },
      { x: centerX + 135, y: centerY + 30 },
      { x: centerX + 155, y: centerY + 70 },
      { x: centerX + 200, y: centerY + 90 }
    ];
    
    ekcPositions.forEach(pos => {
      ekcStars.push({
        x: pos.x,
        y: pos.y,
        size: Math.random() * 3 + 2,
        opacity: 0.7, // opacity کمتر
        speed: Math.random() * 0.02 + 0.01
      });
    });
    
    function animate() {
      if (!ctx || !canvas) return;
      
      // Clear canvas
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      
      // رسم گرادیانت پس‌زمینه
      const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
      gradient.addColorStop(0, '#070b1a');
      gradient.addColorStop(0.3, '#0a0e2a');
      gradient.addColorStop(0.7, '#11183d');
      gradient.addColorStop(1, '#070b1a');
      
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      
      // 1. رسم ستاره‌های پس‌زمینه (اول)
      bgStars.forEach(star => {
        star.opacity += star.speed;
        if (star.opacity > 0.8 || star.opacity < 0.3) {
          star.speed = -star.speed;
        }
        ctx.beginPath();
        ctx.arc(star.x, star.y, star.size, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 255, 255, ${star.opacity})`;
        ctx.fill();
      });
      
      // 2. رسم EKC (بعد - با opacity کنترل شده)
      ekcStars.forEach((star, index) => {
        star.opacity += star.speed;
        if (star.opacity > 0.9 || star.opacity < 0.5) {
          star.speed = -star.speed;
        }
        
        // Glow effect
        ctx.beginPath();
        ctx.arc(star.x, star.y, star.size + 3, 0, Math.PI * 2);
        const glowGradient = ctx.createRadialGradient(
          star.x, star.y, 0,
          star.x, star.y, star.size + 3
        );
        glowGradient.addColorStop(0, 'rgba(79, 195, 247, 0.3)');
        glowGradient.addColorStop(1, 'rgba(79, 195, 247, 0)');
        ctx.fillStyle = glowGradient;
        ctx.fill();
        
        // Star itself
        ctx.beginPath();
        ctx.arc(star.x, star.y, star.size, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(79, 195, 247, ${star.opacity})`;
        ctx.fill();
        
        // Outline
        ctx.beginPath();
        ctx.arc(star.x, star.y, star.size, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(187, 222, 251, ${star.opacity * 0.8})`;
        ctx.lineWidth = 1;
        ctx.stroke();
      });
      
      // 3. رسم خطوط بین ستاره‌های EKC (با opacity کم)
      ctx.strokeStyle = 'rgba(187, 222, 251, 0.4)';
      ctx.lineWidth = 1;
      
      // خطوط حرف E
      ctx.beginPath();
      ctx.moveTo(centerX - 200, centerY - 90);
      ctx.lineTo(centerX - 200, centerY + 90);
      ctx.stroke();
      
      // خطوط افقی E
      [[centerY - 90], [centerY], [centerY + 90]].forEach(y => {
        ctx.beginPath();
        ctx.moveTo(centerX - 200, y);
        ctx.lineTo(centerX - 80, y);
        ctx.stroke();
      });
      
      // خطوط حرف K
      ctx.beginPath();
      ctx.moveTo(centerX, centerY - 100);
      ctx.lineTo(centerX, centerY + 90);
      ctx.stroke();
      
      ctx.beginPath();
      ctx.moveTo(centerX, centerY);
      ctx.lineTo(centerX + 70, centerY - 104);
      ctx.stroke();
      
      ctx.beginPath();
      ctx.moveTo(centerX, centerY);
      ctx.lineTo(centerX + 70, centerY + 86);
      ctx.stroke();
      
      // منحنی حرف C
      ctx.beginPath();
      ctx.moveTo(centerX + 200, centerY - 90);
      ctx.bezierCurveTo(
        centerX + 160, centerY - 80,
        centerX + 130, centerY - 40,
        centerX + 130, centerY
      );
      ctx.bezierCurveTo(
        centerX + 130, centerY + 40,
        centerX + 160, centerY + 80,
        centerX + 200, centerY + 90
      );
      ctx.stroke();
      
      requestAnimationFrame(animate);
    }
    
    animate();
    
    const handleResize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      // Reset stars positions
      bgStars.forEach(star => {
        star.x = Math.random() * canvas.width;
        star.y = Math.random() * canvas.height;
      });
    };
    
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);
  
  return (
    <canvas 
      ref={canvasRef} 
      className="fixed inset-0 pointer-events-none z-0"
      style={{ opacity: 0.7 }} // کاهش opacity کلی
    />
  );
}
