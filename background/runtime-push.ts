export const PANEL_PORT_NAME = 'panel';

export type RuntimePushChannel = 'port' | 'sendMessage';

/** Pick the single SW→panel push channel at send time (no dedup needed). */
export function selectRuntimePushChannel(hasConnectedPanelPort: boolean): RuntimePushChannel {
  return hasConnectedPanelPort ? 'port' : 'sendMessage';
}
