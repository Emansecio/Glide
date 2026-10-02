export type InputBackend = 'bridge' | 'cdp';

/** CDP is always available; native pointer input is used when a hover/drag asks for it. */
export function chooseInputBackend(tool: string, args: Record<string, unknown>): InputBackend {
  const wantsNative = args.native === true && (tool === 'hover' || (tool === 'mouse' && args.action === 'drag'));
  return wantsNative ? 'cdp' : 'bridge';
}
