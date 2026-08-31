import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizeRuntimeSettings } from '../../background/settings-cache.js';
import {
  CHAT_SESSIONS_INDEX_KEY,
  buildLegacyMigrationStorageUpdates,
  chatSessionStorageKey,
} from '../../sidepanel/ui/history-storage.js';
import { readProviderKeyMap } from '../../sidepanel/ui/settings-keys.js';

type StorageFixture = {
  sourceCommit: string;
  local: Record<string, unknown>;
  session: Record<string, unknown>;
};

describe('pre-program storage migration', () => {
  it('loads checkpoint 82772fc settings, sessions, plans, provider slots, and panel ownership without reset', () => {
    const fixture = JSON.parse(
      fs.readFileSync('tests/fixtures/pre-program-storage-82772fc.json', 'utf8'),
    ) as StorageFixture;
    expect(fixture.sourceCommit).toBe('82772fc');

    const runtime = normalizeRuntimeSettings(fixture.local);
    expect(runtime).toMatchObject({
      provider: 'anthropic',
      apiKey: 'legacy-anthropic-key',
      systemPrompt: 'custom pre-program prompt',
      systemPromptMode: 'custom',
    });

    const providerKeys = readProviderKeyMap(fixture.local, String(runtime.provider));
    expect(providerKeys.anthropic).toBe('legacy-anthropic-key');
    expect(providerKeys.codex).toBe('');

    const historyUpdates = buildLegacyMigrationStorageUpdates(
      fixture.local.chatSessions as unknown[],
      new TextEncoder(),
    );
    const migratedLocal = { ...fixture.local, ...historyUpdates };
    expect((migratedLocal[CHAT_SESSIONS_INDEX_KEY] as Array<{ id: string }>).map((entry) => entry.id)).toEqual([
      'legacy-session-1',
    ]);
    expect(migratedLocal[chatSessionStorageKey('legacy-session-1')]).toMatchObject({
      title: 'Legacy session',
      messageCount: 2,
      transcript: [
        { id: 'm1', content: 'keep me' },
        { id: 'm2', content: 'preserved' },
      ],
    });
    expect(migratedLocal.currentPlan).toEqual(fixture.local.currentPlan);
    expect(fixture.session.glideSidePanelTabId).toBe(17);
  });
});
