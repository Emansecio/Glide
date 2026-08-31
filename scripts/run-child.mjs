import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Run current Node executable synchronously and return its exact exit status.
 * Signals and spawn failures map to status 1.
 *
 * @param {string[]} args
 * @param {Record<string, string>} extraEnv
 * @returns {number}
 */
export function runChild(args, extraEnv) {
  const result = spawnSync(process.execPath, args, {
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
  });
  return result.status ?? 1;
}

function parseCliArgs(args) {
  const childArgs = [];
  const extraEnv = {};
  let optionsEnded = false;

  for (const arg of args) {
    if (!optionsEnded && arg === '--') {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && arg.startsWith('--env=')) {
      const assignment = arg.slice('--env='.length);
      const separator = assignment.indexOf('=');
      if (separator < 1) {
        throw new Error(`Invalid environment assignment: ${assignment}`);
      }
      extraEnv[assignment.slice(0, separator)] = assignment.slice(separator + 1);
      continue;
    }
    childArgs.push(arg);
  }

  if (childArgs.length === 0) {
    throw new Error('Missing child script path.');
  }
  return { childArgs, extraEnv };
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  try {
    const { childArgs, extraEnv } = parseCliArgs(process.argv.slice(2));
    process.exitCode = runChild(childArgs, extraEnv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
