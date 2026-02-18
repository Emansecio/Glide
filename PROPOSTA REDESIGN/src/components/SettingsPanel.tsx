import { useState } from 'react';
import {
  Key, ChevronRight, User, SlidersHorizontal,
  Globe, MessageSquare, Zap, Terminal, Save
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

const accordionItems = [
  { id: 'profiles', icon: User, label: 'Perfis' },
  { id: 'model-params', icon: SlidersHorizontal, label: 'Parâmetros do Modelo' },
  { id: 'browser', icon: Globe, label: 'Controles do Navegador' },
  { id: 'response', icon: MessageSquare, label: 'Configurações de Resposta' },
  { id: 'advanced', icon: Zap, label: 'Avançado' },
  { id: 'system-prompt', icon: Terminal, label: 'Prompt do Sistema' },
];

export function SettingsPanel() {
  const [activeTab, setActiveTab] = useState<'geral' | 'perfis'>('geral');
  const [provider, setProvider] = useState('ollama');
  const [apiKey, setApiKey] = useState('');
  const [apiUrl, setApiUrl] = useState('http://localhost:11434');
  const [openAccordion, setOpenAccordion] = useState<string | null>(null);

  return (
    <div className="space-y-5">
      {/* Section title */}
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.15em] text-glide-text-muted px-1">
        Configurações
      </h3>

      {/* Tabs */}
      <div className="flex gap-1.5 bg-glide-surface-2 p-1 rounded-xl border border-glide-border">
        {(['geral', 'perfis'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`flex-1 text-xs font-medium py-2 px-3 rounded-lg capitalize transition-all ${
              activeTab === tab
                ? 'bg-glide-surface-3 text-glide-text border border-glide-border-light shadow-sm'
                : 'text-glide-text-secondary hover:text-glide-text'
            }`}
          >
            {tab === 'geral' ? 'Geral' : 'Perfis'}
          </button>
        ))}
      </div>

      {/* Quick Config Card */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="card-glow-purple rounded-2xl p-4 space-y-4"
        style={{
          background: 'linear-gradient(135deg, rgba(139,92,246,0.06) 0%, rgba(139,92,246,0.02) 100%)',
        }}
      >
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-glide-purple/20 flex items-center justify-center">
            <Key size={13} className="text-glide-purple-light" />
          </div>
          <h4 className="text-sm font-semibold text-glide-text">Configuração Rápida</h4>
        </div>

        {/* Provider */}
        <div className="space-y-1.5">
          <label className="text-[11px] uppercase tracking-wider text-glide-text-muted font-medium">
            Provedor
          </label>
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            className="w-full bg-glide-surface-2 border border-glide-border rounded-xl px-3 py-2.5 text-sm text-glide-text outline-none focus:border-glide-purple/50 transition-colors cursor-pointer appearance-none"
            style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%235a5a6e' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 12px center' }}
          >
            <option value="ollama">Ollama (Local)</option>
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic</option>
            <option value="groq">Groq</option>
          </select>
        </div>

        {/* API Key */}
        <div className="space-y-1.5">
          <label className="text-[11px] uppercase tracking-wider text-glide-text-muted font-medium">
            Chave de API
          </label>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="Insira sua chave de API…"
            className="w-full bg-glide-surface-2 border border-glide-border rounded-xl px-3 py-2.5 text-sm text-glide-text placeholder:text-glide-text-muted outline-none focus:border-glide-purple/50 transition-colors"
          />
          <p className="text-[10px] text-glide-text-muted leading-relaxed">
            Armazenada localmente no seu navegador
          </p>
        </div>

        {/* Model */}
        <div className="space-y-1.5">
          <label className="text-[11px] uppercase tracking-wider text-glide-text-muted font-medium">
            Modelo
          </label>
          <select
            disabled={provider === 'ollama'}
            className="w-full bg-glide-surface-2 border border-glide-border rounded-xl px-3 py-2.5 text-sm text-glide-text-muted outline-none disabled:opacity-50 cursor-pointer appearance-none"
            style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%235a5a6e' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 12px center' }}
          >
            <option>Selecione o provedor primeiro…</option>
          </select>
          {provider === 'ollama' && (
            <p className="text-[10px] text-glide-green/80 leading-relaxed flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-glide-green inline-block" />
              Detectado automaticamente da instância Ollama local
            </p>
          )}
        </div>

        {/* API URL */}
        <div className="space-y-1.5">
          <label className="text-[11px] uppercase tracking-wider text-glide-text-muted font-medium">
            URL da API <span className="normal-case opacity-60">(opcional)</span>
          </label>
          <input
            value={apiUrl}
            onChange={(e) => setApiUrl(e.target.value)}
            className="w-full bg-glide-surface-2 border border-glide-border rounded-xl px-3 py-2.5 text-sm text-glide-text font-mono placeholder:text-glide-text-muted outline-none focus:border-glide-purple/50 transition-colors"
          />
          <p className="text-[10px] text-glide-text-muted leading-relaxed">
            Use apenas se precisar de uma URL personalizada para a API
          </p>
        </div>

        {/* Save button */}
        <button className="w-full py-2.5 bg-glide-purple hover:bg-glide-purple-dark text-white text-sm font-medium rounded-xl transition-all btn-glow hover:scale-[1.01] active:scale-[0.99] flex items-center justify-center gap-2">
          <Save size={14} />
          Salvar Configurações
        </button>
      </motion.div>

      {/* Accordion sections */}
      <div className="space-y-2">
        {accordionItems.map((item) => {
          const Icon = item.icon;
          const isOpen = openAccordion === item.id;
          return (
            <div
              key={item.id}
              className="bg-glide-surface border border-glide-border rounded-xl overflow-hidden transition-colors"
            >
              <button
                onClick={() => setOpenAccordion(isOpen ? null : item.id)}
                className="w-full flex items-center gap-3 px-4 py-3 hover:bg-glide-surface-2 transition-colors"
              >
                <Icon size={15} className="text-glide-text-secondary" />
                <span className="text-sm text-glide-text flex-1 text-left">{item.label}</span>
                <motion.div
                  animate={{ rotate: isOpen ? 90 : 0 }}
                  transition={{ duration: 0.2 }}
                >
                  <ChevronRight size={14} className="text-glide-text-muted" />
                </motion.div>
              </button>
              <AnimatePresence>
                {isOpen && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="overflow-hidden"
                  >
                    <div className="px-4 pb-4 pt-1 border-t border-glide-border">
                      <p className="text-xs text-glide-text-muted leading-relaxed">
                        Configurações de {item.label.toLowerCase()} serão exibidas aqui.
                      </p>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
      </div>
    </div>
  );
}
