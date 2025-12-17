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

    // Function to calculate EKC positions relative to center
    const getEKCPositions = (canvasWidth: number, canvasHeight: number) => {
      const centerX = canvasWidth / 2;
      const centerY = canvasHeight / 2;

      return [
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
    };

    // Initialize EKC stars with current canvas dimensions
    const ekcPositions = getEKCPositions(canvas.width, canvas.height);
    ekcPositions.forEach(pos => {
      ekcStars.push({
        x: pos.x,
        y: pos.y,
        size: Math.random() * 3 + 2,
        opacity: 0.7, // opacity کمتر
        speed: Math.random() * 0.02 + 0.01
      });
    });

    // بارش شهاب سنگ
    interface Meteor {
      x: number;
      y: number;
      length: number;
      speed: number;
      opacity: number;
      angle: number;
      tailLength: number;
      active: boolean;
      size: number;
      color: string;
    }

    const meteors: Meteor[] = [];
    const meteorColors = [
      'rgba(255, 255, 255, 0.9)',
      'rgba(255, 200, 255, 0.8)',
      'rgba(200, 220, 255, 0.8)',
      'rgba(255, 220, 200, 0.8)'
    ];

    // ایجاد شهاب سنگ‌های اولیه
    for (let i = 0; i < 4; i++) {
      meteors.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height * 0.3,
        length: Math.random() * 60 + 30,
        speed: Math.random() * 4 + 2,
        opacity: Math.random() * 0.6 + 0.4,
        angle: Math.PI / 4 + (Math.random() * Math.PI / 8 - Math.PI / 16), // زاویه مورب
        tailLength: Math.random() * 40 + 20,
        active: true,
        size: Math.random() * 1.5 + 1,
        color: meteorColors[Math.floor(Math.random() * meteorColors.length)]
      });
    }

    // تابع برای ایجاد شهاب سنگ جدید
    function createMeteor() {
      if (!canvas) return;
      meteors.push({
        x: Math.random() * canvas.width * 1.5,
        y: -20,
        length: Math.random() * 60 + 30,
        speed: Math.random() * 4 + 2,
        opacity: Math.random() * 0.6 + 0.4,
        angle: Math.PI / 3 + (Math.random() * Math.PI / 6 - Math.PI / 12),
        tailLength: Math.random() * 40 + 20,
        active: true,
        size: Math.random() * 1.5 + 1,
        color: meteorColors[Math.floor(Math.random() * meteorColors.length)]
      });
    }

    // تابع رسم شهاب سنگ
    function drawMeteor(meteor: Meteor) {
      if (!ctx || !canvas || !meteor.active) return;

      // محاسبه موقعیت دم
      const tailX = meteor.x - meteor.tailLength * Math.cos(meteor.angle);
      const tailY = meteor.y - meteor.tailLength * Math.sin(meteor.angle);

      // ایجاد گرادیانت برای دم
      const gradient = ctx.createLinearGradient(
        tailX, tailY,
        meteor.x, meteor.y
      );

      // گرادیانت دم (از کمرنگ به پررنگ)
      gradient.addColorStop(0, 'rgba(255, 255, 255, 0)');
      gradient.addColorStop(0.3, meteor.color.replace('0.8', '0.4'));
      gradient.addColorStop(0.6, meteor.color.replace('0.8', '0.7'));
      gradient.addColorStop(1, meteor.color);

      // رسم دم
      ctx.beginPath();
      ctx.moveTo(tailX, tailY);
      ctx.lineTo(meteor.x, meteor.y);
      ctx.strokeStyle = gradient;
      ctx.lineWidth = meteor.size;
      ctx.lineCap = 'round';
      ctx.stroke();

      // رسم سر شهاب سنگ
      ctx.beginPath();
      ctx.arc(meteor.x, meteor.y, meteor.size * 1.5, 0, Math.PI * 2);

      // گرادیانت دایره سر
      const headGradient = ctx.createRadialGradient(
        meteor.x, meteor.y, 0,
        meteor.x, meteor.y, meteor.size * 2
      );
      headGradient.addColorStop(0, meteor.color);
      headGradient.addColorStop(0.7, meteor.color.replace('0.8', '0.3'));
      headGradient.addColorStop(1, 'rgba(255, 255, 255, 0)');

      ctx.fillStyle = headGradient;
      ctx.fill();

      // افکت درخشش اضافی
      ctx.beginPath();
      ctx.arc(meteor.x, meteor.y, meteor.size * 4, 0, Math.PI * 2);
      const glowGradient = ctx.createRadialGradient(
        meteor.x, meteor.y, meteor.size * 1.5,
        meteor.x, meteor.y, meteor.size * 4
      );
      glowGradient.addColorStop(0, meteor.color.replace('0.8', '0.2'));
      glowGradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
      ctx.fillStyle = glowGradient;
      ctx.fill();
    }

    // تابع به‌روزرسانی موقعیت شهاب سنگ
    function updateMeteor(meteor: Meteor) {
      if (!canvas) return;

      meteor.x += meteor.speed * Math.cos(meteor.angle);
      meteor.y += meteor.speed * Math.sin(meteor.angle);

      // غیرفعال کردن شهاب سنگ اگر از صفحه خارج شود
      if (
        meteor.x < -100 ||
        meteor.x > canvas.width + 100 ||
        meteor.y > canvas.height + 100
      ) {
        meteor.active = false;
      }

      // کاهش تدریجی opacity
      meteor.opacity -= 0.002;
      if (meteor.opacity <= 0) {
        meteor.active = false;
      }
    }

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

      // Calculate center dynamically for each frame
      const centerX = canvas.width / 2;
      const centerY = canvas.height / 2;

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

      // 2. رسم بارش شهاب سنگ
      meteors.forEach((meteor, index) => {
        if (meteor.active) {
          drawMeteor(meteor);
          updateMeteor(meteor);
        } else {
          // حذف شهاب سنگ‌های غیرفعال و ایجاد جدید
          meteors.splice(index, 1);
          if (Math.random() < 0.02) { // 2% chance هر فریم
            createMeteor();
          }
        }
      });

      // اطمینان از اینکه همیشه حداقل 2 شهاب سنگ فعال داریم
      if (meteors.filter(m => m.active).length < 2 && Math.random() < 0.01) {
        createMeteor();
      }

      // 3. رسم EKC (بعد - با opacity کنترل شده)
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

      // 4. رسم خطوط بین ستاره‌های EKC (با opacity کم)
      ctx.strokeStyle = 'rgba(187, 222, 251, 0.4)';
      ctx.lineWidth = 1;

      // خطوط حرف E
      ctx.beginPath();
      ctx.moveTo(centerX - 200, centerY - 90);
      ctx.lineTo(centerX - 200, centerY + 90);
      ctx.stroke();

      // خطوط افقی E
      [centerY - 90, centerY, centerY + 90].forEach(y => {
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
      if (!canvas) return;

      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;

      // Reset stars positions
      bgStars.forEach(star => {
        star.x = Math.random() * canvas.width;
        star.y = Math.random() * canvas.height;
      });

      // Recalculate EKC positions with new canvas dimensions
      const newEkcPositions = getEKCPositions(canvas.width, canvas.height);
      ekcStars.length = 0;
      newEkcPositions.forEach(pos => {
        ekcStars.push({
          x: pos.x,
          y: pos.y,
          size: Math.random() * 3 + 2,
          opacity: 0.7,
          speed: Math.random() * 0.02 + 0.01
        });
      });

      // Reset meteors
      meteors.length = 0;
      for (let i = 0; i < 4; i++) {
        meteors.push({
          x: Math.random() * canvas.width,
          y: Math.random() * canvas.height * 0.3,
          length: Math.random() * 60 + 30,
          speed: Math.random() * 4 + 2,
          opacity: Math.random() * 0.6 + 0.4,
          angle: Math.PI / 4 + (Math.random() * Math.PI / 8 - Math.PI / 16),
          tailLength: Math.random() * 40 + 20,
          active: true,
          size: Math.random() * 1.5 + 1,
          color: meteorColors[Math.floor(Math.random() * meteorColors.length)]
        });
      }
    };

    window.addEventListener('resize', handleResize);

    // ایجاد شهاب سنگ‌های جدید به صورت دوره‌ای
    const meteorInterval = setInterval(() => {
      if (meteors.filter(m => m.active).length < 3) {
        createMeteor();
      }
    }, 3000); // هر 3 ثانیه یک شهاب سنگ جدید

    return () => {
      window.removeEventListener('resize', handleResize);
      clearInterval(meteorInterval);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0 pointer-events-none z-0"
      style={{ opacity: 0.7 }}
    />
  );
}