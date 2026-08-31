import { afterEach, describe, expect, it } from 'vitest';
import { startFixtureServer } from '../e2e/fixture-server.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => close?.());

describe('fixture server', () => {
  it('serves action and frame labs over HTTP', async () => {
    const server = await startFixtureServer();
    close = server.close;
    expect((await fetch(`${server.baseUrl}/action-lab.html`)).status).toBe(200);
    expect(await (await fetch(`${server.baseUrl}/frame-lab.html`)).text()).toContain('child-frame.html');
  });
});
