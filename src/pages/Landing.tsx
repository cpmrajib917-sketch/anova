// @ts-nocheck
import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Sparkles, Tv, Shield, Zap, Compass, ArrowRight, Star } from 'lucide-react';
import { motion } from 'motion/react';

export function Landing() {
  const navigate = useNavigate();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Canvas Starfield + Upward Floating Particles + Shooting Stars Effect
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationFrameId: number;
    let width = (canvas.width = window.innerWidth);
    let height = (canvas.height = window.innerHeight);

    // Mouse tracking for subtle constellation/parallax
    let mouse = { x: width / 2, y: height / 2, active: false };

    const handleMouseMove = (e: MouseEvent) => {
      mouse.x = e.clientX;
      mouse.y = e.clientY;
      mouse.active = true;
    };

    const handleMouseLeave = () => {
      mouse.active = false;
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseleave', handleMouseLeave);

    // Stars
    const numStars = Math.floor((width * height) / 3000);
    const stars: Array<{
      x: number;
      y: number;
      baseX: number;
      baseY: number;
      size: number;
      twinkle: number;
      twinkleSpeed: number;
      baseAlpha: number;
    }> = [];

    for (let i = 0; i < numStars; i++) {
      const rx = Math.random() * width;
      const ry = Math.random() * height;
      stars.push({
        x: rx,
        y: ry,
        baseX: rx,
        baseY: ry,
        size: Math.random() * 1.8 + 0.4,
        twinkle: Math.random() * Math.PI * 2,
        twinkleSpeed: 0.008 + Math.random() * 0.018,
        baseAlpha: 0.3 + Math.random() * 0.7
      });
    }

    // Upward Floating Cosmic Dust Particles
    const numParticles = 50;
    const particles: Array<{
      x: number;
      y: number;
      size: number;
      speedY: number;
      speedX: number;
      alpha: number;
      pulse: number;
      color: string;
    }> = [];

    const colors = ['#00e5ff', '#3b82f6', '#6366f1', '#a855f7', '#38bdf8'];

    for (let i = 0; i < numParticles; i++) {
      particles.push({
        x: Math.random() * width,
        y: Math.random() * height,
        size: Math.random() * 2.4 + 0.8,
        speedY: -(0.25 + Math.random() * 0.55),
        speedX: (Math.random() - 0.5) * 0.35,
        alpha: 0.25 + Math.random() * 0.65,
        pulse: Math.random() * Math.PI * 2,
        color: colors[Math.floor(Math.random() * colors.length)]
      });
    }

    // Shooting Stars
    const shootingStars: Array<{
      x: number;
      y: number;
      length: number;
      speed: number;
      dx: number;
      dy: number;
      alpha: number;
      active: boolean;
    }> = [];

    const spawnShootingStar = () => {
      const startX = Math.random() * width;
      const startY = Math.random() * (height * 0.45);
      const angle = Math.PI / 4 + (Math.random() * 0.2 - 0.1);
      const speed = 6 + Math.random() * 7;
      
      shootingStars.push({
        x: startX,
        y: startY,
        length: 60 + Math.random() * 80,
        speed: speed,
        dx: Math.cos(angle) * speed,
        dy: Math.sin(angle) * speed,
        alpha: 1.0,
        active: true
      });
    };

    const spawnInterval = setInterval(() => {
      if (shootingStars.filter(s => s.active).length < 2) {
        spawnShootingStar();
      }
    }, 2200);

    // Handle resizing
    const handleResize = () => {
      if (!canvas) return;
      width = canvas.width = window.innerWidth;
      height = canvas.height = window.innerHeight;
    };
    window.addEventListener('resize', handleResize);

    // Animation Loop
    const render = () => {
      ctx.fillStyle = '#030712';
      ctx.fillRect(0, 0, width, height);

      // Radial Cosmic Nebula Gradient
      const gradient = ctx.createRadialGradient(
        width * 0.5,
        height * 0.35,
        20,
        width * 0.5,
        height * 0.5,
        width * 0.85
      );
      gradient.addColorStop(0, '#0a1a3a');
      gradient.addColorStop(0.35, '#060d21');
      gradient.addColorStop(1, '#02040a');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);

      // Mouse Parallax Offset
      const targetOffsetX = mouse.active ? (mouse.x - width / 2) * 0.02 : 0;
      const targetOffsetY = mouse.active ? (mouse.y - height / 2) * 0.02 : 0;

      // Draw Twinkling Stars
      stars.forEach(star => {
        star.twinkle += star.twinkleSpeed;
        const currentAlpha = star.baseAlpha * (0.35 + 0.65 * Math.abs(Math.sin(star.twinkle)));
        
        star.x += (star.baseX + targetOffsetX - star.x) * 0.05;
        star.y += (star.baseY + targetOffsetY - star.y) * 0.05;

        ctx.fillStyle = `rgba(255, 255, 255, ${currentAlpha})`;
        ctx.beginPath();
        ctx.arc(star.x, star.y, star.size, 0, Math.PI * 2);
        ctx.fill();

        if (star.size > 1.4) {
          ctx.shadowBlur = 8;
          ctx.shadowColor = '#00e5ff';
          ctx.fillStyle = `rgba(165, 243, 252, ${currentAlpha})`;
          ctx.beginPath();
          ctx.arc(star.x, star.y, star.size + 0.4, 0, Math.PI * 2);
          ctx.fill();
          ctx.shadowBlur = 0;
        }

        // Mouse Constellation Effect
        if (mouse.active) {
          const dx = mouse.x - star.x;
          const dy = mouse.y - star.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < 110) {
            ctx.strokeStyle = `rgba(0, 229, 255, ${0.25 * (1 - dist / 110)})`;
            ctx.lineWidth = 0.8;
            ctx.beginPath();
            ctx.moveTo(star.x, star.y);
            ctx.lineTo(mouse.x, mouse.y);
            ctx.stroke();
          }
        }
      });

      // Draw Floating Particles
      particles.forEach(p => {
        p.y += p.speedY;
        p.x += p.speedX;
        p.pulse += 0.025;

        if (p.y < -10) {
          p.y = height + 10;
          p.x = Math.random() * width;
        }
        if (p.x < 0) p.x = width;
        if (p.x > width) p.x = 0;

        const pAlpha = p.alpha * (0.55 + 0.45 * Math.sin(p.pulse));
        ctx.fillStyle = p.color;
        ctx.globalAlpha = pAlpha;
        ctx.shadowBlur = 12;
        ctx.shadowColor = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 1.0;
      });

      // Update and Draw Shooting Stars
      shootingStars.forEach(s => {
        if (!s.active) return;

        s.x += s.dx;
        s.y += s.dy;
        s.alpha -= 0.016;

        if (s.alpha <= 0 || s.x < 0 || s.x > width || s.y > height) {
          s.active = false;
          return;
        }

        const tailGrad = ctx.createLinearGradient(s.x, s.y, s.x - s.dx * 8, s.y - s.dy * 8);
        tailGrad.addColorStop(0, `rgba(0, 229, 255, ${s.alpha})`);
        tailGrad.addColorStop(0.4, `rgba(99, 102, 241, ${s.alpha * 0.6})`);
        tailGrad.addColorStop(1, `rgba(15, 23, 42, 0)`);

        ctx.strokeStyle = tailGrad;
        ctx.lineWidth = 2.4;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(s.x - s.dx * 8, s.y - s.dy * 8);
        ctx.stroke();

        ctx.shadowBlur = 12;
        ctx.shadowColor = '#00e5ff';
        ctx.fillStyle = `rgba(255, 255, 255, ${s.alpha})`;
        ctx.beginPath();
        ctx.arc(s.x, s.y, 1.8, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
      });

      animationFrameId = requestAnimationFrame(render);
    };

    render();

    return () => {
      cancelAnimationFrame(animationFrameId);
      clearInterval(spawnInterval);
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseleave', handleMouseLeave);
    };
  }, []);

  const handleTagClick = (tag: string) => {
    navigate(`/search?q=${encodeURIComponent(tag)}`);
  };

  return (
    <div className="relative min-h-screen text-white overflow-x-hidden flex flex-col justify-between selection:bg-cyan-500 selection:text-black" id="landing-container">
      {/* Immersive Galaxy Canvas Background */}
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full object-cover pointer-events-none z-0" />

      {/* Nebula ambient glowing radial overlays */}
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-cyan-500/10 rounded-full blur-[140px] pointer-events-none z-0 animate-pulse [animation-duration:8s]" />
      <div className="absolute bottom-1/3 right-10 w-[450px] h-[450px] bg-indigo-600/15 rounded-full blur-[120px] pointer-events-none z-0" />

      {/* Header/Logo */}
      <header className="relative w-full max-w-7xl mx-auto px-6 h-20 flex items-center justify-between z-10">
        <div className="flex items-center gap-2.5 cursor-pointer" onClick={() => navigate('/home')}>
          <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-indigo-600 via-blue-500 to-cyan-400 p-[1px] shadow-[0_0_20px_rgba(0,229,255,0.4)]">
            <div className="w-full h-full bg-[#030712] rounded-[11px] flex items-center justify-center">
              <span className="font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-blue-400 via-cyan-300 to-cyan-400 text-lg">A</span>
            </div>
          </div>
          <span className="text-2xl font-black tracking-tighter bg-clip-text text-transparent bg-gradient-to-r from-white via-slate-100 to-blue-200">
            AnOvA<span className="text-[#00e5ff] animate-pulse">.</span>
          </span>
        </div>

        <button 
          onClick={() => navigate('/home')}
          className="text-xs sm:text-sm font-bold tracking-wide text-[#00e5ff] hover:text-cyan-300 flex items-center gap-2 transition-all group px-4 py-2 rounded-full bg-cyan-500/5 hover:bg-cyan-500/15 border border-cyan-500/20 active:scale-95 cursor-pointer"
        >
          <span>Skip to Library</span>
          <ArrowRight size={15} className="group-hover:translate-x-1 transition-transform text-[#00e5ff]" />
        </button>
      </header>

      {/* Main Content Hero */}
      <main className="relative flex-1 flex flex-col items-center justify-center px-4 py-8 sm:py-12 z-10 max-w-4xl mx-auto text-center">
        
        {/* Top Galactic Badge */}
        <motion.div 
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
          className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-cyan-500/10 border border-cyan-400/30 shadow-[0_0_20px_rgba(0,229,255,0.25)] text-cyan-300 text-[11px] sm:text-xs font-bold mb-6 tracking-wider uppercase backdrop-blur-md"
        >
          <Sparkles size={14} className="text-[#00e5ff] animate-spin [animation-duration:6s]" />
          <span>THE ULTIMATE GALACTIC ANIME STREAMING PORTAL</span>
        </motion.div>

        {/* Display Heading */}
        <motion.h1 
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.7, delay: 0.1 }}
          className="text-4xl sm:text-6xl md:text-7xl font-black tracking-tight leading-none mb-6"
        >
          Watch Free <span className="text-transparent bg-clip-text bg-gradient-to-r from-[#00e5ff] via-blue-400 to-indigo-400 drop-shadow-[0_0_35px_rgba(0,229,255,0.4)]">Anime</span> Online
        </motion.h1>

        {/* Dynamic Subheading */}
        <motion.p 
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.8, delay: 0.2 }}
          className="text-xs sm:text-base md:text-lg text-slate-300 max-w-2xl mx-auto mb-8 leading-relaxed font-medium"
        >
          Stream thousands of HD anime episodes in English Sub & Dub — zero advertisements, zero clutter, purely premium anime experiences tailored for you.
        </motion.p>

        {/* Trending Searches Section with Vibrant Cyan Pill Styling */}
        <motion.div 
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.8, delay: 0.3 }}
          className="flex flex-col items-center gap-4 w-full mb-10"
        >
          {/* Header Badge */}
          <div className="inline-flex items-center gap-2 px-5 py-2 rounded-full bg-cyan-950/50 border border-[#00e5ff] text-xs font-black uppercase tracking-widest text-[#00e5ff] shadow-[0_0_22px_rgba(0,229,255,0.4)] backdrop-blur-md">
            <Star size={14} className="text-amber-400 fill-amber-400 animate-spin [animation-duration:8s]" />
            <span>TRENDING GALACTIC QUERIES</span>
          </div>

          <div className="flex flex-col items-center gap-3 max-w-2xl w-full px-2">
            {/* Row 1 */}
            <div className="flex flex-wrap justify-center gap-2.5">
              <button
                onClick={() => handleTagClick('Solo Leveling Season 2')}
                className="px-4 py-2 rounded-full bg-cyan-500/15 border border-[#00e5ff] text-xs font-extrabold text-[#00e5ff] shadow-[0_0_18px_rgba(0,229,255,0.3)] hover:bg-cyan-500/30 hover:scale-105 active:scale-95 transition-all backdrop-blur-md cursor-pointer"
              >
                Solo Leveling Season 2
              </button>
              <button
                onClick={() => handleTagClick('One Piece')}
                className="px-4 py-2 rounded-full bg-cyan-500/15 border border-[#00e5ff] text-xs font-extrabold text-[#00e5ff] shadow-[0_0_18px_rgba(0,229,255,0.3)] hover:bg-cyan-500/30 hover:scale-105 active:scale-95 transition-all backdrop-blur-md cursor-pointer"
              >
                One Piece
              </button>
            </div>

            {/* Row 2 */}
            <div className="flex flex-wrap justify-center gap-2.5">
              <button
                onClick={() => handleTagClick('Sakamoto Days')}
                className="px-4 py-2 rounded-full bg-cyan-500/15 border border-[#00e5ff] text-xs font-extrabold text-[#00e5ff] shadow-[0_0_18px_rgba(0,229,255,0.3)] hover:bg-cyan-500/30 hover:scale-105 active:scale-95 transition-all backdrop-blur-md cursor-pointer"
              >
                Sakamoto Days
              </button>
            </div>

            {/* Row 3 */}
            <div className="flex flex-wrap justify-center gap-2.5">
              <button
                onClick={() => handleTagClick('Solo Leveling')}
                className="px-4 py-2 rounded-full bg-cyan-500/15 border border-[#00e5ff] text-xs font-extrabold text-[#00e5ff] shadow-[0_0_18px_rgba(0,229,255,0.3)] hover:bg-cyan-500/30 hover:scale-105 active:scale-95 transition-all backdrop-blur-md cursor-pointer"
              >
                Solo Leveling
              </button>
              <button
                onClick={() => handleTagClick('Naruto: Shippuden')}
                className="px-4 py-2 rounded-full bg-cyan-500/20 border border-[#00e5ff] text-xs font-extrabold text-[#00e5ff] shadow-[0_0_22px_rgba(0,229,255,0.4)] hover:bg-cyan-500/35 hover:scale-105 active:scale-95 transition-all backdrop-blur-md cursor-pointer"
              >
                Naruto: Shippuden
              </button>
            </div>

            {/* Row 4 */}
            <div className="flex flex-wrap justify-center gap-2.5">
              <button
                onClick={() => handleTagClick('Blue Lock Season 2')}
                className="px-4 py-2 rounded-full bg-cyan-500/20 border border-[#00e5ff] text-xs font-extrabold text-[#00e5ff] shadow-[0_0_22px_rgba(0,229,255,0.4)] hover:bg-cyan-500/35 hover:scale-105 active:scale-95 transition-all backdrop-blur-md cursor-pointer"
              >
                Blue Lock Season 2
              </button>
            </div>

            {/* Row 5 */}
            <div className="flex flex-wrap justify-center gap-2.5">
              <button
                onClick={() => handleTagClick('Shangri-La Frontier Season 2')}
                className="px-4 py-2 rounded-full bg-cyan-500/15 border border-[#00e5ff] text-xs font-extrabold text-[#00e5ff] shadow-[0_0_18px_rgba(0,229,255,0.3)] hover:bg-cyan-500/30 hover:scale-105 active:scale-95 transition-all backdrop-blur-md cursor-pointer"
              >
                Shangri-La Frontier Season 2
              </button>
              <button
                onClick={() => handleTagClick('Dandadan')}
                className="px-4 py-2 rounded-full bg-cyan-500/20 border border-[#00e5ff] text-xs font-extrabold text-[#00e5ff] shadow-[0_0_22px_rgba(0,229,255,0.4)] hover:bg-cyan-500/35 hover:scale-105 active:scale-95 transition-all backdrop-blur-md cursor-pointer"
              >
                Dandadan
              </button>
            </div>
          </div>
        </motion.div>

        {/* Enter Library Big Gradient Button Call To Action */}
        <motion.div 
          initial={{ opacity: 0, y: 15 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.5 }}
          className="w-full sm:w-auto"
        >
          <button
            onClick={() => navigate('/home')}
            className="group relative w-full sm:w-auto inline-flex items-center justify-center gap-3 px-8 py-4 rounded-2xl bg-gradient-to-r from-indigo-600 via-blue-600 to-cyan-500 hover:from-indigo-500 hover:via-blue-500 hover:to-cyan-400 text-white font-extrabold text-sm sm:text-base tracking-wider uppercase shadow-[0_0_35px_rgba(0,229,255,0.45)] hover:shadow-[0_0_50px_rgba(0,229,255,0.7)] hover:scale-[1.02] active:scale-98 transition-all cursor-pointer overflow-hidden border border-cyan-400/30"
          >
            {/* Glossy light sheen sweep animation */}
            <span className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-1000 ease-in-out pointer-events-none" />
            
            <span>BROWSE ANIME LIBRARY</span>
            <ArrowRight size={20} className="group-hover:translate-x-1.5 transition-transform text-[#00e5ff]" />
          </button>
        </motion.div>
      </main>

      {/* Premium Bento Feature Section (Why AnOvA is Best) */}
      <section className="relative w-full max-w-7xl mx-auto px-6 pt-8 pb-16 z-10">
        <div className="text-center mb-10">
          <h2 className="text-2xl sm:text-3xl font-black tracking-tight mb-2">
            Why <span className="text-transparent bg-clip-text bg-gradient-to-r from-[#00e5ff] via-blue-400 to-indigo-300">AnOvA</span> is the Premium Anime Haven
          </h2>
          <p className="text-xs sm:text-sm text-slate-400 max-w-lg mx-auto font-medium leading-relaxed">
            Experience celestial streaming with optimized infrastructure crafted for high performance.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
          {/* Feature 1 */}
          <div className="p-6 rounded-2xl bg-[#091124]/70 border border-cyan-500/15 backdrop-blur-md shadow-[0_4px_25px_rgba(0,0,0,0.5)] hover:border-cyan-400/40 hover:shadow-[0_0_30px_rgba(0,229,255,0.15)] transition-all group hover:-translate-y-1.5 duration-300">
            <div className="w-12 h-12 rounded-xl bg-cyan-500/15 border border-cyan-400/30 flex items-center justify-center text-[#00e5ff] mb-4 group-hover:bg-cyan-500/25 group-hover:scale-110 transition-all shadow-[0_0_15px_rgba(0,229,255,0.2)]">
              <Tv size={22} />
            </div>
            <h3 className="text-base font-extrabold mb-2 text-slate-100 group-hover:text-[#00e5ff] transition-colors">Galactic Ultra-HD</h3>
            <p className="text-xs text-slate-400 leading-relaxed font-normal">
              Crystal clear high-definition streams supporting multiple adaptive qualities, instantly catering to your bandwidth.
            </p>
          </div>

          {/* Feature 2 */}
          <div className="p-6 rounded-2xl bg-[#091124]/70 border border-indigo-500/15 backdrop-blur-md shadow-[0_4px_25px_rgba(0,0,0,0.5)] hover:border-indigo-400/40 hover:shadow-[0_0_30px_rgba(99,102,241,0.15)] transition-all group hover:-translate-y-1.5 duration-300">
            <div className="w-12 h-12 rounded-xl bg-indigo-500/15 border border-indigo-400/30 flex items-center justify-center text-indigo-400 mb-4 group-hover:bg-indigo-500/25 group-hover:scale-110 transition-all shadow-[0_0_15px_rgba(99,102,241,0.2)]">
              <Shield size={22} />
            </div>
            <h3 className="text-base font-extrabold mb-2 text-slate-100 group-hover:text-indigo-300 transition-colors">Zero Intrusive Ads</h3>
            <p className="text-xs text-slate-400 leading-relaxed font-normal">
              No continuous popup interruptions, clickbait redirection, or clutter. Just continuous, pristine anime streaming.
            </p>
          </div>

          {/* Feature 3 */}
          <div className="p-6 rounded-2xl bg-[#091124]/70 border border-cyan-500/15 backdrop-blur-md shadow-[0_4px_25px_rgba(0,0,0,0.5)] hover:border-cyan-400/40 hover:shadow-[0_0_30px_rgba(0,229,255,0.15)] transition-all group hover:-translate-y-1.5 duration-300">
            <div className="w-12 h-12 rounded-xl bg-cyan-500/15 border border-cyan-400/30 flex items-center justify-center text-[#00e5ff] mb-4 group-hover:bg-cyan-500/25 group-hover:scale-110 transition-all shadow-[0_0_15px_rgba(0,229,255,0.2)]">
              <Zap size={22} />
            </div>
            <h3 className="text-base font-extrabold mb-2 text-slate-100 group-hover:text-[#00e5ff] transition-colors">Instant Update Sync</h3>
            <p className="text-xs text-slate-400 leading-relaxed font-normal">
              Fresh subbed and dubbed anime episodes delivered minutes after their official broadcast release.
            </p>
          </div>

          {/* Feature 4 */}
          <div className="p-6 rounded-2xl bg-[#091124]/70 border border-indigo-500/15 backdrop-blur-md shadow-[0_4px_25px_rgba(0,0,0,0.5)] hover:border-indigo-400/40 hover:shadow-[0_0_30px_rgba(99,102,241,0.15)] transition-all group hover:-translate-y-1.5 duration-300">
            <div className="w-12 h-12 rounded-xl bg-indigo-500/15 border border-indigo-400/30 flex items-center justify-center text-indigo-400 mb-4 group-hover:bg-indigo-500/25 group-hover:scale-110 transition-all shadow-[0_0_15px_rgba(99,102,241,0.2)]">
              <Compass size={22} />
            </div>
            <h3 className="text-base font-extrabold mb-2 text-slate-100 group-hover:text-indigo-300 transition-colors">Smart Recommendations</h3>
            <p className="text-xs text-slate-400 leading-relaxed font-normal">
              Discover customized content with advanced filters and real-time trending charts tailored for cosmic anime lovers.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
