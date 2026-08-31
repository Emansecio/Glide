import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const rootDir = path.resolve('.');
const panelPath = path.join(rootDir, 'dist', 'sidepanel', 'panel.js');
const vendorPath = path.join(rootDir, 'dist', 'sidepanel', 'vendor', 'markdown-it.js');

beforeAll(() => {
  // Keep dist test entrypoints: test:frontier runs them after Vitest.
  execFileSync(process.execPath, ['scripts/build.mjs', '--target=all', '--prod'], {
    cwd: rootDir,
    stdio: 'pipe',
  });
}, 30_000);

describe('production bundle layout', () => {
  it('keeps entry bundles within approved hard limits', () => {
    const metrics = JSON.parse(fs.readFileSync(path.join(rootDir, 'dist', 'build-metrics.json'), 'utf8'));
    expect(metrics.outputs.backgroundBytes).toBeLessThanOrEqual(1_050_000);
    expect(metrics.outputs.panelBytes).toBeLessThanOrEqual(230_000);
    expect(metrics.outputs.contentBytes).toBeLessThanOrEqual(120_000);
  });

  it('loads markdown-it through a static extension-local ESM import', async () => {
    const panelSource = fs.readFileSync(panelPath, 'utf8');
    expect(panelSource).toMatch(/import\s+\w+\s+from["']\.\/vendor\/markdown-it\.js["']/);
    expect(panelSource).not.toContain('import(');

    const vendorModule = await import(`${pathToFileURL(vendorPath).href}?test=${Date.now()}`);
    const markdown = new vendorModule.default({ html: false });
    expect(markdown.render('# Static chunk')).toBe('<h1>Static chunk</h1>\n');
  });
});
