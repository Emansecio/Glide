// Helpers PKCE compartilhados pelos fluxos OAuth (Claude Code e Codex):
// geração de verifier/challenge, captura do redirect observando a URL da aba
// de login e keep-alive do service worker MV3 durante o login interativo.

const base64UrlEncode = (bytes: ArrayBuffer | Uint8Array) => {
  const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let raw = '';
  for (const byte of array) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export const randomUrlSafe = (byteLength: number) => {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
};

export const sha256Challenge = async (verifier: string) => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64UrlEncode(digest);
};

/**
 * Aguarda a aba de login navegar para o redirect_uri e devolve a URL completa
 * (com code/state). Funciona mesmo quando o redirect não carrega (localhost),
 * porque a URL chega em tabs.onUpdated antes da falha de conexão.
 */
const waitForRedirectUrl = (
  tabId: number,
  redirectPrefix: string,
  expectedState: string,
  timeoutMs: number,
): Promise<URL> => {
  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      clearTimeout(timer);
    };
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };

    const onUpdated = (updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => {
      if (updatedTabId !== tabId) return;
      const candidate = changeInfo.url || tab?.pendingUrl || tab?.url || '';
      if (!candidate.startsWith(redirectPrefix)) return;
      try {
        const url = new URL(candidate);
        if (expectedState && url.searchParams.get('state') !== expectedState) {
          settle(() => reject(new Error('OAuth state mismatch — tente novamente.')));
          return;
        }
        settle(() => resolve(url));
      } catch (error) {
        settle(() => reject(error instanceof Error ? error : new Error(String(error))));
      }
    };

    const onRemoved = (removedTabId: number) => {
      if (removedTabId === tabId) {
        settle(() => reject(new Error('Login cancelado (a aba foi fechada).')));
      }
    };

    const timer = setTimeout(
      () => settle(() => reject(new Error('Tempo esgotado aguardando a conclusão do login.'))),
      timeoutMs,
    );

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
  });
};

/** Mantém o service worker MV3 vivo enquanto o usuário completa o login. */
export const startServiceWorkerKeepAlive = () => {
  const keepAlive = setInterval(() => {
    void chrome.runtime.getPlatformInfo?.();
  }, 20000);
  return () => clearInterval(keepAlive);
};

/**
 * Abre a tela de autorização em uma aba, captura o redirect e fecha a aba.
 * Devolve a URL do callback já validada contra o state.
 */
export const runAuthorizeTabFlow = async (
  authorizeUrl: string,
  redirectPrefix: string,
  expectedState: string,
  timeoutMs: number,
): Promise<URL> => {
  const tab = await chrome.tabs.create({ url: authorizeUrl, active: true });
  if (typeof tab.id !== 'number') {
    throw new Error('Não foi possível abrir a aba de login.');
  }
  try {
    return await waitForRedirectUrl(tab.id, redirectPrefix, expectedState, timeoutMs);
  } finally {
    try {
      await chrome.tabs.remove(tab.id);
    } catch {
      // Aba já fechada pelo usuário.
    }
  }
};
