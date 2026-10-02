// Content Script - Runs in the context of web pages
// This script can access the DOM and communicate with the background script

import { installGlideBridge } from './content/glide-bridge.js';

// Toda a interação DOM real acontece via glide-bridge. Não notificamos o background no load:
// a mensagem acordava o service worker em TODO frame de TODA página (all_frames + <all_urls>)
// e ninguém consumia o aviso.
// Guard against reinjection — prevents duplicate listeners on content script reloads.
const GLIDE_INIT_FLAG = '__glide_content_init__';
if (!(window as unknown as Record<string, boolean>)[GLIDE_INIT_FLAG]) {
  (window as unknown as Record<string, boolean>)[GLIDE_INIT_FLAG] = true;
  installGlideBridge();
}
