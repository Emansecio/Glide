import { useState } from 'react';
import {
  Send, Paperclip, Settings, Plus, Menu, Layers, Sparkles
} from 'lucide-react';
import { motion } from 'framer-motion';
import { Orb } from './Orb';

interface ChatViewProps {
  onOpenTabs: () => void;
  onToggleSidebar: () => void;
}

export function ChatView({ onOpenTabs, onToggleSidebar }: ChatViewProps) {
  const [message, setMessage] = useState('');
  const [selectedModel, setSelectedModel] = useState('');

  return (
    <div className="flex flex-col h-full relative">
      {/* Empty state */}
      <div className="flex-1 flex flex-col items-center justify-center px-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
          className="flex flex-col items-center gap-5"
        >
          <Orb />
          <div className="text-center mt-2">
            <h2 className="text-xl font-semibold text-glide-text tracking-tight">
              Pronto quando você estiver
            </h2>
            <p className="text-sm text-glide-text-secondary mt-2 max-w-[280px] leading-relaxed">
              Pergunte algo, adicione abas ou arquivos para começar uma conversa
            </p>
          </div>
        </motion.div>
      </div>

      {/* Composer dock */}
      <motion.div
        initial={{ opacity: 0, y: 30 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.2 }}
        className="px-3 pb-3"
      >
        <div className="bg-glide-surface border border-glide-border rounded-2xl overflow-hidden shadow-lg shadow-black/20">
          {/* Text input */}
          <div className="p-3 pb-2">
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Mensagem…"
              rows={2}
              className="w-full bg-transparent text-glide-text text-sm placeholder:text-glide-text-muted resize-none outline-none leading-relaxed"
            />
          </div>

          {/* Status bar */}
          <div className="px-3 pb-2 flex items-center gap-2">
            <button
              onClick={onToggleSidebar}
              className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-glide-surface-3 text-glide-text-secondary hover:text-glide-text transition-colors"
            >
              <Menu size={15} />
            </button>
            <button
              onClick={onOpenTabs}
              className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-glide-surface-3 text-glide-text-secondary hover:text-glide-text transition-colors"
            >
              <Plus size={15} />
            </button>
            <div className="flex items-center gap-1.5 bg-glide-surface-2 border border-glide-border rounded-full px-2.5 py-1">
              <div className="w-2 h-2 rounded-full bg-glide-green shadow-[0_0_6px_rgba(52,211,153,0.5)]" />
              <span className="text-[11px] text-glide-text-secondary truncate max-w-[40px]">Pron…</span>
              <span className="text-[10px] text-glide-text-muted mx-0.5">·</span>
              <span className="text-[10px] text-glide-text-muted">
                Contexto <span className="text-glide-text-secondary">2194</span> / 200k
              </span>
            </div>
          </div>

          {/* Actions bar */}
          <div className="px-3 pb-3 flex items-center justify-between">
            <div className="flex items-center gap-1">
              <button className="w-8 h-8 flex items-center justify-center rounded-xl hover:bg-glide-surface-3 text-glide-text-secondary hover:text-glide-text transition-colors">
                <Paperclip size={15} />
              </button>
              <button
                onClick={onOpenTabs}
                className="w-8 h-8 flex items-center justify-center rounded-xl hover:bg-glide-surface-3 text-glide-text-secondary hover:text-glide-text transition-colors"
              >
                <Layers size={15} />
              </button>
              <button
                onClick={onToggleSidebar}
                className="w-8 h-8 flex items-center justify-center rounded-xl hover:bg-glide-surface-3 text-glide-text-secondary hover:text-glide-text transition-colors"
              >
                <Settings size={15} />
              </button>

              <div className="ml-2 flex items-center gap-2 bg-glide-surface-2 border border-glide-border rounded-xl px-3 py-1.5">
                <Sparkles size={12} className="text-glide-purple-light" />
                <span className="text-[10px] text-glide-text-muted uppercase tracking-wider font-medium">Modelo</span>
                <select
                  value={selectedModel}
                  onChange={(e) => setSelectedModel(e.target.value)}
                  className="bg-transparent text-xs text-glide-text-secondary outline-none cursor-pointer min-w-[100px]"
                >
                  <option value="" className="bg-glide-surface">Selecionar modelo</option>
                  <option value="gpt-4" className="bg-glide-surface">GPT-4o</option>
                  <option value="claude" className="bg-glide-surface">Claude 3.5</option>
                  <option value="llama" className="bg-glide-surface">Llama 3.1</option>
                  <option value="mixtral" className="bg-glide-surface">Mixtral 8x7B</option>
                </select>
              </div>
            </div>

            <button className="w-9 h-9 flex items-center justify-center rounded-xl bg-glide-purple hover:bg-glide-purple-dark text-white transition-all btn-glow hover:scale-105 active:scale-95">
              <Send size={15} className="translate-x-[0.5px] -translate-y-[0.5px]" />
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
