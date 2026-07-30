import React from 'react';
import { Heart } from 'lucide-react';

export function Footer() {
  return (
    <footer className="relative w-full border-t border-slate-800/60 bg-[#060b18]/80 backdrop-blur-md pt-8 pb-8 px-4 z-10 text-center transition-all">
      <div className="max-w-6xl mx-auto flex flex-col items-center justify-center gap-4">
        
        {/* Tagline & Copyright */}
        <div className="flex flex-col sm:flex-row items-center justify-center gap-2 text-xs text-slate-500">
          <p className="flex items-center gap-1">
            <span>&copy; {new Date().getFullYear()} AnOvA Anime Network.</span>
          </p>
          <span className="hidden sm:inline text-slate-700">•</span>
          <p className="flex items-center gap-1 text-slate-400">
            <span>Dedicated with</span>
            <Heart size={12} className="text-rose-500 inline fill-rose-500/30" />
            <span>for a premier anime ecosystem.</span>
          </p>
        </div>

      </div>
    </footer>
  );
}
