// Visual check of the beginner flow via the Chrome DevTools Protocol.
//
//   node scripts/shots-beginner.js
//
// Starts the real launcher (src/launch.js --no-open --mock), then captures:
//   docs/shots/panel-beginner.png   panel at 1440x1000
//   docs/shots/panel-390.png        panel at 390x844
//   docs/shots/overlay-waiting.png  overlay with no events yet (transparent, as OBS sees it)
// and asserts: 0 console errors, 0 horizontal overflow, waiting hint behaviour.
// Writes docs/shots/beginner-report.json. Exits 1 on any failure.

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(ROOT, 'docs', 'shots');
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startLauncher() {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['src/launch.js', '--no-open', '--mock', '--port=3000'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', (d) => {
      out += d;
      const m = /(http:\/\/127\.0\.0\.1:\d+)\/overlay/.exec(out);
      if (m) resolve({ proc, base: m[1], banner: out });
    });
    proc.stderr.on('data', (d) => process.stderr.write(`[launcher] ${d}`));
    proc.once('exit', (code) => reject(new Error(`launcher exited early (${code})\n${out}`)));
  });
}

function startChrome() {
  const userDir = mkdtempSync(path.join(tmpdir(), 'tlo-chrome-'));
  const proc = spawn(
    CHROME,
    ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${userDir}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars', '--force-device-scale-factor=1', 'about:blank'],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  return new Promise((resolve, reject) => {
    let err = '';
    proc.stderr.on('data', (d) => {
      err += d;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
      if (m) resolve({ proc, wsUrl: m[1], userDir });
    });
    proc.once('exit', (code) => reject(new Error(`chrome exited (${code})`)));
    setTimeout(() => reject(new Error('chrome did not start in 15s')), 15_000).unref();
  });
}

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url, { perMessageDeflate: false });
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    this.ws.on('message', (buf) => {
      const msg = JSON.parse(buf);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) for (const l of this.listeners) l(msg);
    });
  }
  open() {
    return new Promise((res, rej) => {
      this.ws.once('open', res);
      this.ws.once('error', rej);
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
}

const post = (base, p, body = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const report = { errors: [], checks: [] };
  const check = (shot, name, pass, detail = '') => {
    report.checks.push({ shot, check: name, pass: Boolean(pass), detail });
    console.log(`  ${pass ? 'PASS' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
  };

  const launcher = await startLauncher();
  console.log(`launcher up at ${launcher.base}`);
  let chrome;
  try {
    chrome = await startChrome();
    const cdp = new CDP(chrome.wsUrl);
    await cdp.open();
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const s = (m, p) => cdp.send(m, p, sessionId);
    let currentShot = 'boot';
    cdp.listeners.push((m) => {
      if (m.sessionId !== sessionId) return;
      if (m.method === 'Runtime.exceptionThrown') report.errors.push(`[${currentShot}] exception: ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}`);
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') report.errors.push(`[${currentShot}] console.error: ${m.params.args.map((a) => a.value ?? a.description).join(' ')}`);
      if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') report.errors.push(`[${currentShot}] ${m.params.entry.text} ${m.params.entry.url ?? ''}`);
    });
    await s('Page.enable');
    await s('Runtime.enable');
    await s('Log.enable');
    const evaluate = async (expr) => (await s('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value;
    const navigate = async (url) => {
      const loaded = new Promise((r) => cdp.listeners.push((m) => m.method === 'Page.loadEventFired' && m.sessionId === sessionId && r()));
      await s('Page.navigate', { url });
      await loaded;
    };
    const waitFor = async (expr, ms = 5000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (await evaluate(expr)) return true;
        await sleep(50);
      }
      return false;
    };
    const capture = async (file) => {
      const { data } = await s('Page.captureScreenshot', { format: 'png' });
      writeFileSync(path.join(SHOTS, file), Buffer.from(data, 'base64'));
    };
    const overflow = `(() => {
      const w = document.documentElement.clientWidth;
      const wide = [...document.querySelectorAll('body *')].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && (r.right > w + 1 || r.left < -1) && getComputedStyle(el).position !== 'absolute';
      }).map((el) => el.id || el.className || el.tagName).slice(0, 5);
      return { scrollWidth: document.documentElement.scrollWidth, clientWidth: w, wide };
    })()`;

    // ---------- panel at 1440x1000 and 390x844 ----------
    for (const [file, width, height, mobile] of [
      ['panel-beginner.png', 1440, 1000, false],
      ['panel-390.png', 390, 844, true],
    ]) {
      currentShot = file;
      console.log(`\n${file}`);
      await s('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
      await s('Emulation.setDefaultBackgroundColorOverride', {});
      await navigate(`${launcher.base}/panel`);
      check(file, 'server status loaded', await waitFor("/cổng \\d+/.test(document.querySelector('#status').textContent)"));
      await sleep(400);
      const dom = await evaluate(`({
        steps: [...document.querySelectorAll('.step__title')].map((h) => h.textContent.trim()),
        url: document.querySelector('#overlay-url').value,
        urlFits: (() => { const b = document.querySelector('#overlay-url'); return b.scrollWidth <= b.clientWidth; })(),
        themeCards: document.querySelectorAll('.theme-card').length,
        selected: document.querySelector('input[name="theme"]:checked')?.value ?? null,
        copyBtn: !!document.querySelector('#copy') && document.querySelector('#copy').offsetWidth > 0,
        testBtn: document.querySelector('#test-gift').offsetWidth > 0,
        advancedOpen: document.querySelector('#advanced').open,
        connText: document.querySelector('#conn-status').textContent,
        bodyText: document.body.innerText,
      })`);
      check(file, '3 step headings', dom.steps.length === 3 && dom.steps.every((t, i) => t.includes(`BƯỚC ${i + 1}`)), dom.steps.join(' | '));
      check(file, 'OBS URL uses the real port', dom.url === `${launcher.base}/overlay`, dom.url);
      check(file, 'OBS URL fully visible (not cut off)', dom.urlFits);
      check(file, '3 theme cards, one selected', dom.themeCards === 3 && dom.selected !== null, `selected=${dom.selected}`);
      check(file, 'copy + test-gift buttons visible', dom.copyBtn && dom.testBtn);
      check(file, 'advanced collapsed by default', dom.advancedOpen === false);
      check(file, 'no raw JSON / template text visible', !/[{}]|undefined|\[object/.test(dom.bodyText));
      const ov = await evaluate(overflow);
      check(file, 'no horizontal overflow', ov.scrollWidth <= ov.clientWidth && ov.wide.length === 0, `scrollWidth ${ov.scrollWidth} / clientWidth ${ov.clientWidth}${ov.wide.length ? ` offenders: ${ov.wide.join(', ')}` : ''}`);
      await capture(file);
    }

    // Interactions at 390px: theme switch applies instantly, test gift works without connecting.
    currentShot = 'panel-interactions';
    console.log('\npanel interactions');
    await evaluate(`document.querySelector('input[name="theme"][value="tet"]').click()`);
    const themed = await waitFor(`fetch('/health').then(r => r.json()).then(h => h.config.theme === 'tet')`);
    check('panel', 'clicking a theme card applies instantly', themed);
    await evaluate(`document.querySelector('input[name="theme"][value="temple"]').click()`);
    await waitFor(`fetch('/health').then(r => r.json()).then(h => h.config.theme === 'temple')`);
    await evaluate(`document.querySelector('#test-gift').click()`);
    check('panel', 'test-gift shows a Vietnamese toast', await waitFor(`/Đã bắn quà thử/.test(document.querySelector('#toast').textContent)`));
    await evaluate(`document.querySelector('#username').value = 'có dấu cách'; document.querySelector('#connect').click()`);
    await sleep(2500); // outlive one /health poll: the friendly message must stay
    const bad = await evaluate(`({ text: document.querySelector('#conn-status').textContent, retry: !document.querySelector('#retry').hidden })`);
    check('panel', 'invalid name shows friendly message + Thử lại', /chữ cái/.test(bad.text) && bad.retry, bad.text);

    // ---------- overlay waiting state ----------
    currentShot = 'overlay-waiting.png';
    console.log('\noverlay-waiting.png');
    await post(launcher.base, '/api/mock/stop');
    await post(launcher.base, '/api/clear');
    await s('Emulation.setDeviceMetricsOverride', { width: 1080, height: 1920, deviceScaleFactor: 1, mobile: false });
    await s('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    await navigate(`${launcher.base}/overlay`);
    await sleep(800);
    const w = await evaluate(`(() => {
      const el = document.querySelector('#waiting');
      const r = el.getBoundingClientRect();
      return { visible: !el.hidden && getComputedStyle(el).opacity > 0, text: el.textContent,
               cx: r.left + r.width / 2, cy: r.top + r.height / 2,
               bodyBg: getComputedStyle(document.body).backgroundColor, htmlBg: getComputedStyle(document.documentElement).backgroundColor };
    })()`);
    check('overlay-waiting.png', 'waiting hint visible with no events', w.visible && w.text === 'Đang chờ quà tặng…', w.text);
    check('overlay-waiting.png', 'hint centered', Math.abs(w.cx - 540) < 2 && Math.abs(w.cy - 960) < 2, `${Math.round(w.cx)},${Math.round(w.cy)}`);
    check('overlay-waiting.png', 'page background transparent', w.bodyBg === 'rgba(0, 0, 0, 0)' && w.htmlBg === 'rgba(0, 0, 0, 0)', `${w.bodyBg} / ${w.htmlBg}`);
    const ov = await evaluate(overflow);
    check('overlay-waiting.png', 'no horizontal overflow', ov.scrollWidth <= ov.clientWidth, `scrollWidth ${ov.scrollWidth}`);
    await capture('overlay-waiting.png');

    await post(launcher.base, '/api/test-gift');
    const gone = await waitFor(`window.__overlay.stats().waitingVisible === false`, 3000);
    await sleep(900);
    const hiddenAfter = await evaluate(`document.querySelector('#waiting').hidden`);
    check('overlay', 'hint fades out on first event and is removed', gone && hiddenAfter);
    await navigate(`${launcher.base}/overlay`);
    await sleep(600);
    check('overlay', 'hint does not come back after reload once events flowed', await evaluate(`document.querySelector('#waiting').hidden`));
    await post(launcher.base, '/api/clear');
    await navigate(`${launcher.base}/overlay?demo=1`);
    await sleep(600);
    check('overlay', '?demo=1 never shows the hint', await evaluate(`document.querySelector('#waiting').hidden`));

    await cdp.send('Target.closeTarget', { targetId });
  } finally {
    chrome?.proc.kill();
    launcher.proc.kill('SIGINT');
    if (chrome?.userDir) {
      await sleep(300);
      rmSync(chrome.userDir, { recursive: true, force: true });
    }
  }

  writeFileSync(path.join(SHOTS, 'beginner-report.json'), JSON.stringify(report, null, 2));
  const failed = report.checks.filter((c) => !c.pass);
  console.log(`\nconsole errors: ${report.errors.length}`);
  for (const e of report.errors) console.log(`  ${e}`);
  console.log(`checks: ${report.checks.length - failed.length}/${report.checks.length} passed`);
  if (failed.length || report.errors.length) process.exit(1);
}

main().catch((err) => {
  console.error('screenshot run failed:', err);
  process.exit(1);
});
