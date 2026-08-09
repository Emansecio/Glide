// Content Script - Runs in the context of web pages
// This script can access the DOM and communicate with the background script

import { installGlideBridge } from './content/glide-bridge.js';

// Toda a interação DOM real acontece via glide-bridge; aqui só sinalizamos ao
// background que o content script carregou nesta página.
const notifyReady = () => {
  chrome.runtime
    .sendMessage({
      type: 'content_script_ready',
      url: window.location.href,
    })
    .catch((err) => {
      if (err?.message?.includes('Could not establish connection')) return;
      console.warn('content_script_ready failed:', err);
    });
};

// Guard against reinjection — prevents duplicate listeners on content script reloads.
const GLIDE_INIT_FLAG = '__glide_content_init__';
if (!(window as unknown as Record<string, boolean>)[GLIDE_INIT_FLAG]) {
  (window as unknown as Record<string, boolean>)[GLIDE_INIT_FLAG] = true;
  installGlideBridge();
  notifyReady();
}
