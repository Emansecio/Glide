export type InputBackend = 'bridge' | 'cdp';
export type InputBackendDecision = InputBackend | { error: 'NATIVE_INPUT_PERMISSION_REQUIRED' };

export function chooseInputBackend(
  tool: string,
  args: Record<string, unknown>,
  debuggerEnabled: boolean,
): InputBackendDecision {
  const wantsNative = args.native === true && (tool === 'hover' || (tool === 'mouse' && args.action === 'drag'));
  if (!wantsNative) return 'bridge';
  if (!debuggerEnabled) return { error: 'NATIVE_INPUT_PERMISSION_REQUIRED' };
  return 'cdp';
}
