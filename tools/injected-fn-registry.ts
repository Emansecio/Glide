/**
 * Registry de funções injetadas, por aba/frame/world.
 *
 * chrome.scripting.executeScript({ func }) serializa o corpo INTEIRO da função
 * a cada chamada — as ferramentas pesadas (getContent ~26KB, getNetworkRequests
 * ~25KB, readPage ~9KB) pagam serialização + IPC + parse em TODA tool call.
 * Aqui a função é instalada uma vez por página (globalThis.__glideFnRegistry)
 * e as chamadas seguintes despacham por id (~100 bytes). Se a página bloqueia
 * eval via CSP, o shim devolve um marcador ANTES de rodar a tool e o caller
 * cai para a injeção direta (comportamento anterior).
 *
 * Os shims são serializados e re-executados no contexto da página: NÃO podem
 * referenciar nada fora do próprio corpo (constantes, imports, helpers).
 */

export type InjectedFn = (...args: any[]) => unknown;

const sourceToId = new Map<string, string>();
let nextInjectedFnSeq = 0;

/**
 * Id estável por SOURCE. Os call sites passam arrows inline — um objeto novo a
 * cada chamada, mas com source idêntico — então chavear por objeto (WeakMap)
 * faria o cache errar sempre.
 */
export function getInjectedFnId(fn: InjectedFn): string {
  const src = String(fn);
  let id = sourceToId.get(src);
  if (!id) {
    nextInjectedFnSeq += 1;
    id = `glide_fn_${nextInjectedFnSeq}`;
    sourceToId.set(src, id);
  }
  return id;
}

/** Instala o source no registry da página e já executa a chamada (uma ida só). */
export function glideInstallAndRunInjectedFn(id: string, src: string, callArgs: unknown): Promise<unknown> {
  const w = globalThis as Record<string, any>;
  const registry = (w.__glideFnRegistry ||= { fns: Object.create(null) });
  try {
    // Function constructor: page CSP sem unsafe-eval rejeita — o marcador
    // abaixo faz o caller repetir a chamada com injeção direta (a tool ainda
    // não rodou).
    registry.fns[id] = new Function(`return (${src});`)();
  } catch (error) {
    return Promise.resolve({
      __glideFnEvalBlocked: true,
      message: error instanceof Error ? error.message : String(error),
    });
  }
  const invokeArgs = Array.isArray(callArgs) ? callArgs : [];
  return Promise.resolve(registry.fns[id](...invokeArgs)).then((value) => ({ __glideFnResult: true, value }));
}

/** Despacho barato (~100 bytes serializados) para funções já instaladas. */
export function glideDispatchInjectedFn(id: string, callArgs: unknown): Promise<unknown> {
  const w = globalThis as Record<string, any>;
  const fn = w.__glideFnRegistry?.fns?.[id];
  if (typeof fn !== 'function') return Promise.resolve({ __glideFnMissing: true });
  const invokeArgs = Array.isArray(callArgs) ? callArgs : [];
  return Promise.resolve(fn(...invokeArgs)).then((value) => ({ __glideFnResult: true, value }));
}

export function isInjectedFnResult(value: unknown): value is { __glideFnResult: true; value: unknown } {
  return (
    Boolean(value) && typeof value === 'object' && (value as { __glideFnResult?: unknown }).__glideFnResult === true
  );
}

export function isInjectedFnMissing(value: unknown): boolean {
  return (
    Boolean(value) && typeof value === 'object' && (value as { __glideFnMissing?: unknown }).__glideFnMissing === true
  );
}

export function isInjectedFnEvalBlocked(value: unknown): boolean {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    (value as { __glideFnEvalBlocked?: unknown }).__glideFnEvalBlocked === true
  );
}

/** Só para testes. */
export function resetInjectedFnIdsForTests(): void {
  sourceToId.clear();
  nextInjectedFnSeq = 0;
}
