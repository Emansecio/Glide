import { useState } from 'react';
import { ChatView } from './components/ChatView';
import { Sidebar } from './components/Sidebar';
import { TabModal } from './components/TabModal';

export function App() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [tabModalOpen, setTabModalOpen] = useState(false);

  return (
    <div className="w-full h-screen bg-glide-bg flex items-center justify-center">
      {/* Extension container - simulating browser extension popup */}
      <div className="relative w-full max-w-[420px] h-[680px] bg-glide-bg rounded-2xl border border-glide-border overflow-hidden shadow-2xl shadow-black/60 flex flex-col">
        {/* Subtle top gradient */}
        <div className="absolute top-0 left-0 right-0 h-32 pointer-events-none"
          style={{
            background: 'radial-gradient(ellipse at 50% -20%, rgba(139,92,246,0.08) 0%, transparent 70%)',
          }}
        />

        {/* Main content */}
        <ChatView
          onOpenTabs={() => setTabModalOpen(true)}
          onToggleSidebar={() => setSidebarOpen(true)}
        />

        {/* Sidebar overlay */}
        <Sidebar
          isOpen={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
        />

        {/* Tab modal overlay */}
        <TabModal
          isOpen={tabModalOpen}
          onClose={() => setTabModalOpen(false)}
        />
      </div>
    </div>
  );
}
