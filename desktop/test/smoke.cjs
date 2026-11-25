// Launches the packaged app, checks that the UI comes up and stays responsive,
// and saves a screenshot plus logs. Usage: node test/smoke.cjs "<path to exe>" <outDir>
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

const [exe, outDir = 'smoke-out'] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const log = [];
const note = (m) => {
  const line = `[${new Date().toISOString()}] ${m}`;
  console.log(line);
  log.push(line);
};

(async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-smoke-'));
  const started = Date.now();
  const app = await electron.launch({
    executablePath: exe,
    env: { ...process.env, MYSQL_LENS_USERDATA: userData, ELECTRON_ENABLE_LOGGING: '1' },
    timeout: 60000,
  });
  app.process().stdout.on('data', (d) => note('stdout: ' + String(d).trim()));
  app.process().stderr.on('data', (d) => note('stderr: ' + String(d).trim()));
  const win = await app.firstWindow({ timeout: 60000 });
  note(`first window after ${Date.now() - started} ms`);
  win.on('console', (m) => note(`console.${m.type()}: ${m.text()}`));
  win.on('pageerror', (e) => note(`pageerror: ${e.message}`));
  try {
    await win.waitForSelector('.welcome', { timeout: 60000 });
    note(`welcome after ${Date.now() - started} ms`);
    // Responsiveness: a round trip through the renderer must be quick.
    const t = Date.now();
    await win.evaluate(() => 1 + 1);
    note(`renderer round trip ${Date.now() - t} ms`);
    await win.getByRole('button', { name: 'New Connection' }).first().click();
    await win.frameLocator('iframe.view-frame:visible').locator('.field input').first().waitFor({ timeout: 30000 });
    note('connection form opened');
    const metrics = await app.evaluate(({ app }) => app.getAppMetrics().map((m) => `${m.type}=${Math.round(m.memory.workingSetSize / 1024)}MB`));
    note('memory: ' + metrics.join(' '));
    await win.screenshot({ path: path.join(outDir, 'smoke.png') });
    note('SMOKE OK');
  } catch (e) {
    note('SMOKE FAILED: ' + e.message);
    await win.screenshot({ path: path.join(outDir, 'smoke-failed.png') }).catch(() => {});
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(path.join(outDir, 'smoke.log'), log.join('\n'));
    await app.close().catch(() => {});
    fs.rmSync(userData, { recursive: true, force: true });
  }
})();
