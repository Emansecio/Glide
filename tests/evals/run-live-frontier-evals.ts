import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const LIVE_FRONTIER_CASES = [
  { id: 'example-read', url: 'https://example.com/', expectedText: 'Example Domain' },
  { id: 'iana-reserved-read', url: 'https://www.iana.org/help/example-domains', expectedText: 'example' },
] as const;

type LiveEvalOptions = {
  env?: Record<string, string | undefined>;
  execute?: () => Promise<number>;
};

const executeLiveManifest = async () => {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  let failed = false;
  try {
    for (const evalCase of LIVE_FRONTIER_CASES) {
      const page = await browser.newPage();
      try {
        const response = await page.goto(evalCase.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        const bodyText = await page.locator('body').innerText();
        const passed = Boolean(response?.ok()) && bodyText.toLowerCase().includes(evalCase.expectedText.toLowerCase());
        console.log(`${passed ? 'PASS' : 'FAIL'} ${evalCase.id} ${evalCase.url}`);
        if (!passed) failed = true;
      } catch (error) {
        failed = true;
        console.error(`FAIL ${evalCase.id} ${evalCase.url}: ${(error as Error).message}`);
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
  return failed ? 1 : 0;
};

export const runLiveFrontierEvals = async (options: LiveEvalOptions = {}) => {
  const env = options.env ?? process.env;
  if (env.GLIDE_LIVE_TESTS !== '1') {
    console.log('SKIP live frontier evals (set GLIDE_LIVE_TESTS=1 to enable).');
    return 0;
  }
  return (options.execute ?? executeLiveManifest)();
};

const isCli = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isCli) {
  runLiveFrontierEvals()
    .then((status) => {
      process.exitCode = status;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
