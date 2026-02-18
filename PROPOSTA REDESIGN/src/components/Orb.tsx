import { motion } from 'framer-motion';

export function Orb() {
  return (
    <div className="relative w-28 h-28 flex items-center justify-center">
      {/* Outer glow ring */}
      <motion.div
        className="absolute inset-0 rounded-full animate-pulse-glow"
        style={{
          background: 'radial-gradient(circle, rgba(139,92,246,0.2) 0%, transparent 70%)',
        }}
        animate={{ scale: [1, 1.15, 1], opacity: [0.3, 0.6, 0.3] }}
        transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }}
      />
      {/* Rotating gradient ring */}
      <div className="absolute inset-3 rounded-full animate-orb-rotate" style={{
        background: 'conic-gradient(from 0deg, rgba(139,92,246,0.0), rgba(139,92,246,0.4), rgba(168,85,247,0.6), rgba(139,92,246,0.4), rgba(139,92,246,0.0))',
        filter: 'blur(4px)',
      }} />
      {/* Main sphere */}
      <motion.div
        className="relative w-20 h-20 rounded-full orb-glow"
        style={{
          background: 'radial-gradient(circle at 35% 35%, #a78bfa, #7c3aed 40%, #5b21b6 80%, #4c1d95)',
        }}
        animate={{ y: [0, -6, 0] }}
        transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }}
      >
        {/* Highlight */}
        <div className="absolute top-3 left-4 w-6 h-4 rounded-full bg-white/20 blur-sm" />
        {/* Inner glow */}
        <div className="absolute inset-0 rounded-full" style={{
          background: 'radial-gradient(circle at 50% 50%, rgba(167,139,250,0.3) 0%, transparent 60%)',
        }} />
      </motion.div>
    </div>
  );
}
