import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const svgPath = path.join(root, 'icons', 'glide-logo.svg');
const svg = fs.readFileSync(svgPath, 'utf8');
const sizes = [16, 48, 128];

const browser = await chromium.launch();
const page = await browser.newPage();

for (const size of sizes) {
  const scaled = svg.replace('<svg ', `<svg width="${size}" height="${size}" `);
  // Transparent page — mark only, no black plate.
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:transparent">
${scaled}
</body></html>`;
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(html, { waitUntil: 'load' });
  await page.screenshot({
    path: path.join(root, 'icons', `icon${size}.png`),
    clip: { x: 0, y: 0, width: size, height: size },
    omitBackground: true,
  });
  console.log(`wrote icons/icon${size}.png`);
}

await browser.close();
