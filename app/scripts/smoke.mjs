// Smoke test for the Windows build: starts the app with WebView2 remote debugging,
// checks that the UI comes up and responds, and records memory use.
// Usage: node scripts/smoke.mjs <path-to-exe> <out-dir>
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const [exe, out = 'smoke-out'] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const log = [];
const note = (m) => {
  const line = `[${new Date().toISOString()}] ${m}`;
  console.log(line);
  log.push(line);
};

const started = Date.now();
const app = spawn(exe, [], { env: { ...process.env, MYSQL_LENS_REMOTE_DEBUG_PORT: '9333' }, stdio: 'inherit' });
let ok = false;
try {
  let browser;
  for (let i = 0; i < 60 && !browser; i++) {
    try {
      browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (!browser) throw new Error('WebView2 did not expose the debugging port');
  // The debugging port can answer before the app's page exists; wait for it.
  let page;
  for (let i = 0; i < 60 && !page; i++) {
    page = browser.contexts().flatMap((c) => c.pages()).find((p) => !p.url().startsWith('devtools://'));
    if (!page) await new Promise((r) => setTimeout(r, 500));
  }
  if (!page) throw new Error('The app window did not appear');
  note(`page: ${page.url()}`);
  page.on('pageerror', (e) => note('pageerror: ' + e.message));
  page.on('console', (m) => m.type() === 'error' && note('console.error: ' + m.text()));
  await page.waitForSelector('text=Fast, lightweight', { timeout: 30000 });
  note(`UI ready after ${Date.now() - started} ms`);
  const t = Date.now();
  await page.evaluate(() => 1 + 1);
  note(`renderer round trip ${Date.now() - t} ms`);
  note(`native backend: ${await page.evaluate(() => '__TAURI_INTERNALS__' in window)}`);
  await page.getByText('New connection').first().click();
  await page.waitForSelector('text=MySQL 5.7+', { timeout: 10000 });
  note('connection dialog opened');
  await page.keyboard.press('Escape');
  await new Promise((r) => setTimeout(r, 3000));
  const mem = execSync(
    'powershell -NoProfile -Command "Get-Process mysql-lens,msedgewebview2 -ErrorAction SilentlyContinue | Select-Object Name,@{n=\'MB\';e={[math]::Round($_.WorkingSet64/1MB)}} | ConvertTo-Json"',
  ).toString();
  const procs = [].concat(JSON.parse(mem || '[]'));
  note('memory: ' + procs.map((p) => `${p.Name}=${p.MB}MB`).join(' ') + ` · total ${procs.reduce((a, p) => a + p.MB, 0)} MB`);
  await page.screenshot({ path: path.join(out, 'smoke.png') });
  ok = true;
  note('SMOKE OK');
  await browser.close().catch(() => {});
} catch (e) {
  note('SMOKE FAILED: ' + e.message);
  process.exitCode = 1;
} finally {
  fs.writeFileSync(path.join(out, 'smoke.log'), log.join('\n'));
  app.kill();
  if (!ok) process.exitCode = 1;
}
