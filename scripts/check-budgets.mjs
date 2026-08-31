import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const REQUIRED_BUDGET_KEYS = [
  'backgroundBytes',
  'panelBytes',
  'contentBytes',
  'coreToolSchemaChars',
  'fullToolSchemaChars',
];

export const loadPerformanceBudgets = (budgetPath) => {
  if (!fs.existsSync(budgetPath)) throw new Error(`Budget file missing: ${budgetPath}`);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(budgetPath, 'utf8'));
  } catch (error) {
    throw new Error(`Budget file invalid: ${error.message}`);
  }
  for (const key of REQUIRED_BUDGET_KEYS) {
    if (!Number.isFinite(parsed?.[key]) || parsed[key] <= 0) {
      throw new Error(`${key} must be a finite positive number`);
    }
  }
  return parsed;
};

export const checkMeasuredBudgets = (budgets, measured) => {
  const errors = [];
  for (const key of REQUIRED_BUDGET_KEYS) {
    const value = measured?.[key];
    if (!Number.isFinite(value) || value < 0) {
      errors.push(`${key} measurement missing or invalid`);
    } else if (value > budgets[key]) {
      errors.push(`${key} measured ${value} > allowed ${budgets[key]}`);
    }
  }
  return { passed: errors.length === 0, errors };
};

const measureToolSchemas = async (rootDir) => {
  const build = await esbuild.build({
    entryPoints: [path.join(rootDir, 'ai', 'tool-packs.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    write: false,
    logLevel: 'silent',
  });
  const source = build.outputFiles[0].text;
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  const { buildPackedToolDefinitions } = await import(moduleUrl);
  const allPacks = ['core', 'forms', 'extract', 'diagnostics', 'tabs', 'advanced'];
  return {
    coreToolSchemaChars: JSON.stringify(buildPackedToolDefinitions(['core'], Number.POSITIVE_INFINITY)).length,
    fullToolSchemaChars: JSON.stringify(buildPackedToolDefinitions(allPacks, Number.POSITIVE_INFINITY)).length,
  };
};

export const runBudgetCheck = async (rootDir) => {
  const budgets = loadPerformanceBudgets(path.join(rootDir, 'config', 'performance-budgets.json'));
  const metricsPath = path.join(rootDir, 'dist', 'build-metrics.json');
  if (!fs.existsSync(metricsPath)) throw new Error(`Build metrics missing: ${metricsPath}; run npm run build first`);
  const buildMetrics = JSON.parse(fs.readFileSync(metricsPath, 'utf8'));
  const measured = {
    ...buildMetrics.outputs,
    ...(await measureToolSchemas(rootDir)),
  };
  const result = checkMeasuredBudgets(budgets, measured);
  for (const key of REQUIRED_BUDGET_KEYS) console.log(`${key}: ${measured[key]} / ${budgets[key]}`);
  if (!result.passed) throw new Error(result.errors.join('\n'));
  console.log('Performance budgets passed.');
  return { budgets, measured };
};

const isCli = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isCli) {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  runBudgetCheck(rootDir).catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
