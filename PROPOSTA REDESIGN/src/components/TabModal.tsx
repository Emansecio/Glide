import { useState } from 'react';
import { X, Plus, Trash2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

interface TabModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const fakeTabs = [
  { id: 1, title: 'Como usar IA para automação de tarefas do navegador', domain: 'youtube.com', favicon: '🎬' },
  { id: 2, title: 'WhatsApp Web — Conversa com equipe de design', domain: 'web.whatsapp.com', favicon: '💬' },
  { id: 3, title: 'GitHub — glide-extension/main — Pull Requests', domain: 'github.com', favicon: '🐙' },
  { id: 4, title: 'Stack Overflow — How to build chrome extensions with React', domain: 'stackoverflow.com', favicon: '📚' },
  { id: 5, title: 'Tailwind CSS — Rapidly build modern websites', domain: 'tailwindcss.com', favicon: '🎨' },
  { id: 6, title: 'MDN Web Docs — WebExtensions API', domain: 'developer.mozilla.org', favicon: '📖' },
  { id: 7, title: 'Google Docs — Especificação de requisitos do projeto Glide', domain: 'docs.google.com', favicon: '📝' },
];

export function TabModal({ isOpen, onClose }: TabModalProps) {
  const [selectedTabs, setSelectedTabs] = useState<number[]>([]);

  const toggleTab = (id: number) => {
    setSelectedTabs(prev =>
      prev.includes(id) ? prev.filter(t => t !== id) : [...prev, id]
    );
  };

  const selectAll = () => {
    setSelectedTabs(fakeTabs.map(t => t.id));
  };

  const clearAll = () => {
    setSelectedTabs([]);
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="absolute inset-0 z-50 flex items-center justify-center p-4"
        >
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-modal"
            onClick={onClose}
          />

          {/* Modal */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{ duration: 0.25, ease: 'easeOut' }}
            className="relative w-full max-w-[380px] max-h-[85vh] bg-glide-surface border border-glide-border rounded-2xl shadow-2xl shadow-black/40 flex flex-col overflow-hidden"
          >
            {/* Header */}
            <div className="p-4 pb-3 border-b border-glide-border space-y-3">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-2 flex-1">
                  <h3 className="text-sm font-semibold text-glide-text">
                    Adicionar contexto de abas
                  </h3>
                  <span className={`text-[9px] uppercase tracking-wider font-bold px-2 py-0.5 rounded-full ${
                    selectedTabs.length > 0
                      ? 'bg-glide-purple/20 text-glide-purple-light'
                      : 'bg-glide-surface-3 text-glide-text-muted'
                  }`}>
                    {selectedTabs.length > 0
                      ? `${selectedTabs.length} selecionada${selectedTabs.length > 1 ? 's' : ''}`
                      : 'Nenhuma aba selecionada'}
                  </span>
                </div>
                <button
                  onClick={onClose}
                  className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-glide-surface-3 text-glide-text-muted hover:text-glide-text transition-colors -mr-1"
                >
                  <X size={14} />
                </button>
              </div>

              <p className="text-[11px] text-glide-text-muted leading-relaxed">
                Abas selecionadas adicionam títulos + URLs ao seu prompt para dar contexto ao modelo.
              </p>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => toggleTab(fakeTabs[0].id)}
                  className="flex items-center gap-1.5 bg-glide-purple hover:bg-glide-purple-dark text-white text-[11px] font-medium px-3 py-1.5 rounded-lg transition-all"
                >
                  <Plus size={12} />
                  Adicionar aba ativa
                </button>
                <button
                  onClick={clearAll}
                  className="flex items-center gap-1.5 bg-glide-surface-2 border border-glide-border hover:bg-glide-surface-3 text-glide-text-secondary text-[11px] font-medium px-3 py-1.5 rounded-lg transition-all"
                >
                  <Trash2 size={11} />
                  Limpar
                </button>
              </div>

              <p className="text-[10px] text-glide-text-muted/60 italic">
                💡 Dica: use grupos de abas para organizar contextos
              </p>
            </div>

            {/* Tab list */}
            <div className="flex-1 overflow-y-auto p-3 space-y-2">
              {/* Group header */}
              <div className="flex items-center justify-between px-2 py-1">
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-glide-text-secondary font-medium">Sem grupo</span>
                  <span className="text-[10px] bg-glide-surface-3 text-glide-text-muted px-1.5 py-0.5 rounded-md font-medium">
                    {fakeTabs.length}
                  </span>
                </div>
                <button
                  onClick={selectAll}
                  className="text-[10px] uppercase tracking-wider font-bold text-glide-purple-light hover:text-glide-purple transition-colors"
                >
                  Adicionar todas
                </button>
              </div>

              {/* Tab items */}
              {fakeTabs.map((tab) => {
                const isSelected = selectedTabs.includes(tab.id);
                return (
                  <motion.button
                    key={tab.id}
                    onClick={() => toggleTab(tab.id)}
                    whileTap={{ scale: 0.98 }}
                    className={`w-full flex items-center gap-3 p-2.5 rounded-xl transition-all text-left ${
                      isSelected
                        ? 'bg-glide-purple/10 border border-glide-purple/30'
                        : 'bg-glide-surface-2 border border-glide-border hover:bg-glide-surface-3 hover:border-glide-border-light'
                    }`}
                  >
                    {/* Checkbox */}
                    <div className={`w-4 h-4 rounded-md border-2 flex items-center justify-center flex-shrink-0 transition-all ${
                      isSelected
                        ? 'bg-glide-purple border-glide-purple'
                        : 'border-glide-border-light'
                    }`}>
                      {isSelected && (
                        <motion.svg
                          initial={{ scale: 0 }}
                          animate={{ scale: 1 }}
                          width="10" height="10" viewBox="0 0 10 10" fill="none"
                        >
                          <path d="M2 5L4 7L8 3" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        </motion.svg>
                      )}
                    </div>

                    {/* Favicon */}
                    <span className="text-sm flex-shrink-0">{tab.favicon}</span>

                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-glide-text truncate leading-relaxed">
                        {tab.title}
                      </p>
                      <p className="text-[10px] text-glide-text-muted truncate">
                        {tab.domain}
                      </p>
                    </div>
                  </motion.button>
                );
              })}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
