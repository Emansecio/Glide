import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import esbuild from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');

const ensureDir = (dir) => fs.mkdirSync(dir, { recursive: true });
const cleanDir = (dir) => {
  fs.rmSync(dir, { recursive: true, force: true });
  ensureDir(dir);
};

const copyFile = (src, dest) => {
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
};

const copyDirFiltered = (src, dest, filter) => {
  if (!fs.existsSync(src)) return;
  const entries = fs.readdirSync(src, { withFileTypes: true });
  entries.forEach((entry) => {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirFiltered(srcPath, destPath, filter);
      return;
    }
    if (filter && !filter(srcPath)) {
      return;
    }
    copyFile(srcPath, destPath);
  });
};

const runTypeCheck = () => {
  const tscPath = path.join(rootDir, 'node_modules', '.bin', 'tsc');
  const cmd = fs.existsSync(tscPath) ? `"${tscPath}"` : 'tsc';
  execSync(`${cmd} -p tsconfig.json --noEmit`, { stdio: 'inherit', shell: true });
};

// Production can be requested cross-platform via `--prod` (no cross-env needed)
// or the conventional NODE_ENV. Production drops console, minifies and omits
// sourcemaps so the packaged extension does not ship TS source.
const isProduction = process.env.NODE_ENV === 'production' || process.argv.includes('--prod');

// esbuild splitting:true needs format:'esm' (already used) but emits runtime
// import() chunks. MV3 module service workers only allow dynamic import from
// within the SW file itself — shared chunks break registration, so no splitting.

const buildExtensionBundles = async () => {
  const commonExtConfig = {
    outdir: distDir,
    outbase: rootDir,
    bundle: true,
    platform: 'browser',
    target: 'es2022',
    sourcemap: !isProduction,
    logLevel: 'info',
    minify: isProduction,
    drop: isProduction ? ['console'] : undefined,
    define: isProduction ? { 'process.env.NODE_ENV': '"production"' } : undefined,
    metafile: true,
  };

  await esbuild.build({
    ...commonExtConfig,
    entryPoints: [path.join(rootDir, 'background.ts'), path.join(rootDir, 'sidepanel', 'panel.ts')],
    format: 'esm',
  });

  await esbuild.build({
    ...commonExtConfig,
    entryPoints: [path.join(rootDir, 'content.ts')],
    format: 'iife',
  });

  const manifestPath = path.join(rootDir, 'manifest.json');
  const manifestDest = path.join(distDir, 'manifest.json');
  const manifestData = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  ensureDir(path.dirname(manifestDest));
  fs.writeFileSync(manifestDest, JSON.stringify(manifestData, null, 2));
  copyFile(path.join(rootDir, 'sidepanel', 'panel.html'), path.join(distDir, 'sidepanel', 'panel.html'));
  copyFile(path.join(rootDir, 'sidepanel', 'panel.css'), path.join(distDir, 'sidepanel', 'panel.css'));
  copyDirFiltered(path.join(rootDir, 'sidepanel', 'styles'), path.join(distDir, 'sidepanel', 'styles'));
  copyDirFiltered(path.join(rootDir, 'sidepanel', 'templates'), path.join(distDir, 'sidepanel', 'templates'));
  copyDirFiltered(path.join(rootDir, 'icons'), path.join(distDir, 'icons'), (file) => file.endsWith('.png'));
  // Só os .woff2: o LICENSE.md fica no repositório, fora do pacote.
  copyDirFiltered(path.join(rootDir, 'fonts'), path.join(distDir, 'fonts'), (file) => file.endsWith('.woff2'));
  copyDirFiltered(path.join(rootDir, 'local'), path.join(distDir, 'local'));
};

const buildTestBundles = async () => {
  await esbuild.build({
    entryPoints: [
      path.join(rootDir, 'tests', 'run-tests.ts'),
      path.join(rootDir, 'tests', 'validate-extension.ts'),
      path.join(rootDir, 'tests', 'unit', 'run-unit-tests.ts'),
      path.join(rootDir, 'tests', 'e2e', 'run-e2e.ts'),
      path.join(rootDir, 'tests', 'e2e', 'test-frontier-actions.ts'),
      path.join(rootDir, 'tests', 'e2e', 'test-worker-recovery.ts'),
      path.join(rootDir, 'tests', 'e2e', 'test-model-communication.ts'),
      path.join(rootDir, 'tests', 'e2e', 'test-live-model-e2e.ts'),
      path.join(rootDir, 'tests', 'integration', 'test-ollama-sdk.ts'),
      path.join(rootDir, 'tests', 'integration', 'test-model-correctness.ts'),
    ],
    outdir: distDir,
    outbase: rootDir,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'es2022',
    sourcemap: true,
    logLevel: 'info',
    external: ['playwright', 'chromium-bidi/lib/cjs/bidiMapper/BidiMapper', 'chromium-bidi/lib/cjs/cdp/CdpConnection'],
  });
};

const getBuildTarget = () => {
  const arg = process.argv.find((value) => value.startsWith('--target='));
  const target = arg ? arg.split('=')[1] : 'ext';
  if (!['ext', 'test', 'all'].includes(target)) {
    throw new Error(`Invalid build target: "${target}". Use --target=ext|test|all`);
  }
  return target;
};

const run = async () => {
  const target = getBuildTarget();

  if (target === 'ext' || target === 'all') {
    cleanDir(distDir);
  } else {
    ensureDir(distDir);
  }

  runTypeCheck();

  if (target === 'ext' || target === 'all') {
    await buildExtensionBundles();
  }
  if (target === 'test' || target === 'all') {
    await buildTestBundles();
  }
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
