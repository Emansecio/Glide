import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = {
  ...process.env,
  GLIDE_LIVE_TESTS: '1',
  E2E_TIMEOUT: process.env.E2E_TIMEOUT || '120000',
};

const steps = [
  ['Live Ollama SDK', path.join(rootDir, 'dist', 'tests', 'integration', 'test-ollama-sdk.js')],
  ['Live Model Correctness', path.join(rootDir, 'dist', 'tests', 'integration', 'test-model-correctness.js')],
  ['Live Model E2E', path.join(rootDir, 'dist', 'tests', 'e2e', 'test-live-model-e2e.js')],
];

for (const [label, scriptPath] of steps) {
  console.log(`\n▶ ${label}`);
  const result = spawnSync(process.execPath, [scriptPath], { stdio: 'inherit', env });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}
