import { useState } from 'react';
import {
  X, MessageCircle, Clock, Settings, Sparkles
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { SettingsPanel } from './SettingsPanel';

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
}

const navItems = [
  { id: 'chat', icon: MessageCircle, label: 'Conversa' },
  { id: 'history', icon: Clock, label: 'Histórico' },
  { id: 'settings', icon: Settings, label: 'Configurações' },
];

export function Sidebar({ isOpen, onClose }: SidebarProps) {
  const [activeNav, setActiveNav] = useState('settings');

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-40 bg-black/40"
            onClick={onClose}
          />

          {/* Sidebar panel */}
          <motion.div
            initial={{ x: -320, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: -320, opacity: 0 }}
            transition={{ type: 'spring', damping: 30, stiffness: 300 }}
            className="absolute left-0 top-0 bottom-0 z-50 w-[320px] bg-glide-bg border-r border-glide-border flex flex-col shadow-2xl shadow-black/50"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-glide-border">
              <div className="flex items-center gap-2.5">
                <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-glide-purple to-glide-purple-dark flex items-center justify-center shadow-md">
                  <Sparkles size={13} className="text-white" />
                </div>
                <span className="text-sm font-bold text-glide-text tracking-tight">Glide</span>
              </div>
              <button
                onClick={onClose}
                className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-glide-surface-2 text-glide-text-muted hover:text-glide-text transition-colors"
              >
                <X size={15} />
              </button>
            </div>

            {/* Navigation */}
            <div className="px-2 py-3 space-y-0.5 border-b border-glide-border">
              {navItems.map((item) => {
                const Icon = item.icon;
                const isActive = activeNav === item.id;
                return (
                  <button
                    key={item.id}
                    onClick={() => setActiveNav(item.id)}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all relative ${
                      isActive
                        ? 'bg-glide-surface-2 text-glide-text'
                        : 'text-glide-text-secondary hover:bg-glide-surface hover:text-glide-text'
                    }`}
                  >
                    {isActive && (
                      <motion.div
                        layoutId="nav-indicator"
                        className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 bg-glide-purple rounded-r-full"
                        transition={{ type: 'spring', damping: 25, stiffness: 300 }}
                      />
                    )}
                    <Icon size={16} className={isActive ? 'text-glide-purple-light' : ''} />
                    <span className="text-sm font-medium">{item.label}</span>
                  </button>
                );
              })}
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto px-3 py-4">
              {activeNav === 'settings' && <SettingsPanel />}
              {activeNav === 'chat' && (
                <div className="flex flex-col items-center justify-center h-full text-center gap-3 py-12">
                  <MessageCircle size={28} className="text-glide-text-muted" />
                  <p className="text-sm text-glide-text-secondary">Nenhuma conversa ativa</p>
                  <p className="text-xs text-glide-text-muted">Inicie uma nova conversa para começar</p>
                </div>
              )}
              {activeNav === 'history' && (
                <div className="flex flex-col items-center justify-center h-full text-center gap-3 py-12">
                  <Clock size={28} className="text-glide-text-muted" />
                  <p className="text-sm text-glide-text-secondary">Histórico vazio</p>
                  <p className="text-xs text-glide-text-muted">Suas conversas anteriores aparecerão aqui</p>
                </div>
              )}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
