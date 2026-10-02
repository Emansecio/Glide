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

// Keep service worker self-contained. Side panel may use static extension-local
// ESM imports: MV3 permits these and they avoid runtime code generation/CSP changes.
const panelMarkdownVendorPlugin = {
  name: 'panel-markdown-vendor',
  setup(build) {
    build.onResolve({ filter: /^\.\.\/vendor\/markdown-it\.js$/ }, () => ({
      path: './vendor/markdown-it.js',
      external: true,
    }));
  },
};

// The AI SDK imports zod as a namespace value, which keeps `z.locales` (~40 languages,
// >100 KB) alive in the service worker. Nothing here calls `z.locales.*`, and zod
// registers English through a direct import, so the index is reduced to `en` only.
const zodLocalesPlugin = {
  name: 'zod-locales-en-only',
  setup(build) {
    build.onResolve({ filter: /locales[\\/]index\.js$/ }, (args) => {
      if (!args.importer.replaceAll('\\', '/').includes('/node_modules/zod/')) return undefined;
      return { path: path.join(path.dirname(args.importer), '..', 'locales', 'index.js'), namespace: 'zod-locales' };
    });
    build.onLoad({ filter: /.*/, namespace: 'zod-locales' }, (args) => ({
      contents: `export { default as en } from ${JSON.stringify(path.join(path.dirname(args.path), 'en.js'))};`,
      resolveDir: path.dirname(args.path),
      loader: 'js',
    }));
  },
};

// Service-worker shims for SDK code Glide never reaches (see scripts/shims/*). Test bundles
// use the same aliases so tests exercise exactly what ships.
const sdkShimAliases = {
  'zod/v3': path.join(rootDir, 'scripts', 'shims', 'zod-v3.js'),
  '@ai-sdk/gateway': path.join(rootDir, 'scripts', 'shims', 'ai-gateway.js'),
};

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
    charset: 'utf8',
    legalComments: 'none',
  };

  const backgroundBuild = await esbuild.build({
    ...commonExtConfig,
    entryPoints: [path.join(rootDir, 'background.ts')],
    format: 'esm',
    plugins: [zodLocalesPlugin],
    alias: sdkShimAliases,
  });

  const panelBuild = await esbuild.build({
    ...commonExtConfig,
    entryPoints: [path.join(rootDir, 'sidepanel', 'panel.ts')],
    format: 'esm',
    plugins: [panelMarkdownVendorPlugin],
  });

  const markdownVendorBuild = await esbuild.build({
    ...commonExtConfig,
    entryPoints: [path.join(rootDir, 'sidepanel', 'vendor', 'markdown-it.ts')],
    outfile: path.join(distDir, 'sidepanel', 'vendor', 'markdown-it.js'),
    outdir: undefined,
    outbase: undefined,
    format: 'esm',
  });

  const contentBuild = await esbuild.build({
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
  // local/ holds optional developer credentials (e.g. local/command-code.json) that the
  // unpacked extension bootstraps on first run. dist/ then carries them — never share it.
  if (fs.existsSync(path.join(rootDir, 'local'))) {
    copyDirFiltered(path.join(rootDir, 'local'), path.join(distDir, 'local'));
    console.warn('⚠ dist/local/ contém credenciais locais — não compartilhe nem publique este dist/.');
  }

  const metafiles = [
    backgroundBuild.metafile,
    panelBuild.metafile,
    markdownVendorBuild.metafile,
    contentBuild.metafile,
  ];
  const outputBytes = (suffix) => {
    for (const metafile of metafiles) {
      const entry = Object.entries(metafile.outputs).find(([output]) => output.replaceAll('\\', '/').endsWith(suffix));
      if (entry) return entry[1].bytes;
    }
    throw new Error(`Build output missing from metafile: ${suffix}`);
  };
  const inputBytes = new Map();
  for (const metafile of metafiles) {
    for (const output of Object.values(metafile.outputs)) {
      for (const [input, contribution] of Object.entries(output.inputs || {})) {
        inputBytes.set(input, (inputBytes.get(input) || 0) + contribution.bytesInOutput);
      }
    }
  }
  const buildMetrics = {
    outputs: {
      backgroundBytes: outputBytes('dist/background.js'),
      panelBytes: outputBytes('dist/sidepanel/panel.js'),
      contentBytes: outputBytes('dist/content.js'),
    },
    topInputs: [...inputBytes.entries()]
      .map(([input, bytes]) => ({ input, bytes }))
      .sort((left, right) => right.bytes - left.bytes)
      .slice(0, 15),
  };
  fs.writeFileSync(path.join(distDir, 'build-metrics.json'), `${JSON.stringify(buildMetrics, null, 2)}\n`);
};

const buildTestBundles = async () => {
  await esbuild.build({
    entryPoints: [
      path.join(rootDir, 'tests', 'run-tests.ts'),
      path.join(rootDir, 'tests', 'validate-extension.ts'),
      path.join(rootDir, 'tests', 'unit', 'run-unit-tests.ts'),
      path.join(rootDir, 'tests', 'e2e', 'run-e2e.ts'),
      path.join(rootDir, 'tests', 'e2e', 'test-frontier-actions.ts'),
      path.join(rootDir, 'tests', 'e2e', 'test-stable-handles.ts'),
      path.join(rootDir, 'tests', 'e2e', 'test-worker-recovery.ts'),
      path.join(rootDir, 'tests', 'e2e', 'test-frontier-runtime-evals.ts'),
      path.join(rootDir, 'tests', 'e2e', 'test-model-communication.ts'),
      path.join(rootDir, 'tests', 'e2e', 'test-live-model-e2e.ts'),
      path.join(rootDir, 'tests', 'evals', 'run-frontier-evals.ts'),
      path.join(rootDir, 'tests', 'evals', 'run-live-frontier-evals.ts'),
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
    alias: sdkShimAliases,
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
