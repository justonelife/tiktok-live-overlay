// Visual verification via the Chrome DevTools Protocol (no Puppeteer).
//
//   node scripts/screenshots.js
//
// 1. Starts the server in MOCK mode as a child process (MOCK=1) on a random port.
// 2. Launches headless Chrome, viewport 1080x1920, transparent default background.
// 3. For each theme: clears state, seeds history, loads /overlay, injects mock
//    gifts / a live streak / comments, captures docs/shots/{theme}.png (transparent,
//    exactly what OBS composites) and docs/shots/{theme}-on-dark.png (same frame
//    over a dark backdrop for human review).
// 4. Also captures temple at 390px width to check the responsive layout.
// 5. Collects console errors / exceptions and asserts DOM invariants. Exits 1 on failure.

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(ROOT, 'docs', 'shots');
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const THEMES = ['temple', 'neon', 'tet'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- tiny PNG decoder (8-bit RGBA, non-interlaced) to verify transparency ----------
function pngAlphaStats(buf) {
  let off = 8;
  let w = 0;
  let h = 0;
  let colorType = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      colorType = data[9];
      if (data[8] !== 8 || data[12] !== 0) throw new Error('unsupported PNG');
    } else if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  if (colorType !== 6) return { w, h, hasAlpha: false, transparentRatio: 0 };
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = 4;
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + x] = v & 0xff;
    }
  }
  let transparent = 0;
  for (let i = 3; i < out.length; i += 4) if (out[i] === 0) transparent++;
  return { w, h, hasAlpha: true, transparentRatio: transparent / (w * h), cornerAlpha: out[3] };
}

// ---------- minimal CDP client ----------
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
        msg.error ? reject(new Error(`${msg.error.message} ${msg.error.data ?? ''}`)) : resolve(msg.result);
      } else if (msg.method) {
        for (const l of this.listeners) l(msg);
      }
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
  on(fn) {
    this.listeners.push(fn);
  }
}

// ---------- server + chrome processes ----------
function startServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['src/server.js'], {
      cwd: ROOT,
      env: { ...process.env, MOCK: '1', MOCK_RATE: '3', PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    proc.stdout.on('data', (d) => {
      out += d;
      const m = /overlay: (http:\/\/[^\s]+)\/overlay/.exec(out);
      if (m) resolve({ proc, base: m[1] });
    });
    proc.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
    proc.once('exit', (code) => reject(new Error(`server exited early (${code})`)));
  });
}

function startChrome() {
  const userDir = mkdtempSync(path.join(tmpdir(), 'ovl-chrome-'));
  const proc = spawn(
    CHROME,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--hide-scrollbars',
      '--autoplay-policy=no-user-gesture-required',
      '--force-device-scale-factor=1',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  return new Promise((resolve, reject) => {
    let err = '';
    proc.stderr.on('data', (d) => {
      err += d;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
      if (m) resolve({ proc, wsUrl: m[1], userDir });
    });
    proc.once('exit', (code) => reject(new Error(`chrome exited (${code}): ${err.slice(0, 500)}`)));
    setTimeout(() => reject(new Error('chrome did not start in 15s')), 15_000).unref();
  });
}

// ---------- scenario ----------
async function api(base, p, body) {
  const res = await fetch(base + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${p} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
}

const U = {
  linh: { id: 'u1001', name: 'Linh Nguyen' },
  minh: { id: 'u1002', name: 'Minh Tran' },
  hoa: { id: 'u1003', name: 'Hoa Le' },
  bao: { id: 'u1004', name: 'BaoPham' },
  lotus: { id: 'u1005', name: 'golden_lotus' },
  sky: { id: 'u1006', name: 'Sky Walker' },
};
const G = {
  rose: { id: '5655', name: 'Rose', diamond: 1 },
  heart: { id: '5487', name: 'Finger Heart', diamond: 5 },
  perfume: { id: '5658', name: 'Perfume', diamond: 20 },
  corgi: { id: '6267', name: 'Corgi', diamond: 299 },
  galaxy: { id: '11046', name: 'Galaxy', diamond: 1000 },
};
const gift = (user, g, repeatCount = 1, extra = {}) => ({ type: 'gift', user, gift: { ...g, repeatCount, ...extra } });

/** History seeded BEFORE the overlay loads: builds the leaderboard + 17 prior Rose sends by Linh. */
function history() {
  const ev = [];
  for (let i = 0; i < 17; i++) ev.push(gift(U.linh, G.rose, 3, { streakable: false }));
  ev.push(gift(U.minh, G.corgi, 1, { streakable: false }));
  ev.push(gift(U.hoa, G.perfume, 6, { streakable: false }));
  ev.push(gift(U.bao, G.heart, 9, { streakable: false }));
  ev.push(gift(U.lotus, G.perfume, 4, { streakable: false }));
  ev.push(gift(U.sky, G.heart, 2, { streakable: false }));
  return ev;
}

async function runScenario(base) {
  await api(base, '/api/mock/emit', [
    { type: 'comment', user: U.hoa, text: 'Chào cả nhà 👋' },
    { type: 'comment', user: U.sky, text: 'Love the overlay ✨' },
    { type: 'comment', user: U.bao, text: 'Hay quá!' },
    { type: 'comment', user: U.minh, text: 'Hello from Saigon!' },
  ]);
  // Linh's 18th Rose send: a streak of 5 that ends explicitly -> banner "18th time".
  for (let n = 1; n <= 5; n++) {
    await api(base, '/api/mock/emit', gift(U.linh, G.rose, n));
    await sleep(60);
  }
  await api(base, '/api/mock/emit', gift(U.linh, G.rose, 5, { repeatEnd: true }));
  // A big non-streak gift -> mega particle burst + leaderboard reorder (Sky jumps to #1).
  await api(base, '/api/mock/emit', gift(U.sky, G.galaxy, 1, { streakable: false }));
  // An in-progress streak -> combo counter ticking (no repeatEnd yet).
  for (let n = 1; n <= 12; n++) {
    await api(base, '/api/mock/emit', gift(U.minh, G.heart, n));
    await sleep(25);
  }
}

// ---------- main ----------
async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const report = { shots: [], errors: [], checks: [] };
  const { proc: server, base } = await startServer();
  console.log(`server (mock mode): ${base}`);
  let chrome;
  try {
    chrome = await startChrome();
    console.log(`chrome: ${chrome.wsUrl}`);
    const cdp = new CDP(chrome.wsUrl);
    await cdp.open();
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const s = (m, p) => cdp.send(m, p, sessionId);

    let currentShot = 'init';
    cdp.on((msg) => {
      if (msg.sessionId !== sessionId) return;
      if (msg.method === 'Runtime.exceptionThrown') {
        report.errors.push(`[${currentShot}] exception: ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`);
      } else if (msg.method === 'Runtime.consoleAPICalled' && (msg.params.type === 'error' || msg.params.type === 'assert')) {
        report.errors.push(`[${currentShot}] console.${msg.params.type}: ${msg.params.args.map((a) => a.value ?? a.description).join(' ')}`);
      } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
        report.errors.push(`[${currentShot}] log: ${msg.params.entry.text} ${msg.params.entry.url ?? ''}`);
      }
    });
    await s('Runtime.enable');
    await s('Log.enable');
    await s('Page.enable');

    const evaluate = async (expr) => {
      const r = await s('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(`evaluate failed: ${r.exceptionDetails.text}`);
      return r.result.value;
    };
    const capture = async (file, bg) => {
      await s('Emulation.setDefaultBackgroundColorOverride', { color: bg });
      const { data } = await s('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const buf = Buffer.from(data, 'base64');
      writeFileSync(path.join(SHOTS, file), buf);
      return buf;
    };
    const TRANSPARENT = { r: 0, g: 0, b: 0, a: 0 };
    const DARK = { r: 32, g: 36, b: 48, a: 1 };

    const shoot = async (theme, width, height, suffix = '') => {
      currentShot = `${theme}${suffix}`;
      await api(base, '/api/clear', {});
      await api(base, '/api/config', {
        theme,
        ticker: true,
        template: theme === 'tet' ? '{user} tặng {gift} {unit} — lần thứ {count}' : '{user} sent {gift} {unit} · {ordinal} time',
      });
      await api(base, '/api/mock/emit', history());

      await s('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await s('Emulation.setDefaultBackgroundColorOverride', { color: TRANSPARENT });
      const loaded = new Promise((r) => cdp.on((m) => m.method === 'Page.loadEventFired' && m.sessionId === sessionId && r()));
      await s('Page.navigate', { url: `${base}/overlay` });
      await loaded;
      // Wait for the WS hello (leaderboard rendered from snapshot).
      for (let i = 0; i < 100; i++) {
        if (await evaluate('window.__overlay?.stats().leaderboard.length === 5')) break;
        await sleep(50);
      }
      await runScenario(base);
      await sleep(650);

      const dom = await evaluate(`(() => {
        const cs = (sel) => getComputedStyle(document.querySelector(sel));
        const vis = (sel) => { const el = document.querySelector(sel); const r = el.getBoundingClientRect(); return !el.hidden && r.width > 0 && r.height > 0; };
        const inside = [...document.querySelectorAll('.banner, .board, .combo, .ticker')].filter(e => !e.hidden).every(e => {
          const r = e.getBoundingClientRect(); return r.left >= -1 && r.right <= innerWidth + 1 && r.top >= -1 && r.bottom <= innerHeight + 1;
        });
        return {
          ...window.__overlay.stats(),
          htmlBg: cs('html').backgroundColor,
          bodyBg: cs('body').backgroundColor,
          overflow: cs('body').overflow,
          scrolls: document.documentElement.scrollHeight > innerHeight || document.documentElement.scrollWidth > innerWidth,
          bannerVisible: vis('#banner'),
          bannerText: document.querySelector('.banner__text').textContent,
          comboVisible: vis('#combo'),
          comboN: document.querySelector('.combo__n').textContent,
          tickerItems: document.querySelectorAll('.ticker__item').length,
          particles: document.querySelectorAll('#particles .p').length,
          panelsInsideViewport: inside,
          bannerBg: cs('.banner').backgroundImage.slice(0, 60),
          fontFamily: cs('body').fontFamily.slice(0, 40),
          backdrop: [...document.querySelectorAll('*')].some(e => { const v = getComputedStyle(e).backdropFilter; return v && v !== 'none'; }),
          width: innerWidth,
        };
      })()`);

      const file = `${theme}${suffix}.png`;
      const png = await capture(file, TRANSPARENT);
      const alpha = pngAlphaStats(png);
      if (!suffix) await capture(`${theme}-on-dark.png`, DARK);

      const expectFirst = 'u1006'; // Sky Walker: 10 + 1000 = 1010 diamonds
      const checks = {
        themeApplied: dom.theme === theme,
        transparentBg: dom.htmlBg === 'rgba(0, 0, 0, 0)' && dom.bodyBg === 'rgba(0, 0, 0, 0)',
        noScrollbars: dom.overflow === 'hidden' && !dom.scrolls,
        noBackdropFilter: !dom.backdrop,
        bannerShows18th: dom.bannerVisible && /18/.test(dom.bannerText),
        comboTicking: dom.comboVisible && dom.comboN === '12',
        leaderboardTop5: dom.leaderboard.length === 5 && dom.leaderboard[0] === expectFirst,
        tickerHasComments: dom.tickerItems === 4,
        particlesAlive: dom.particles > 0 && dom.liveParticles <= 160,
        domNodesCapped: dom.nodes < 600,
        panelsInsideViewport: dom.panelsInsideViewport,
        pngHasTransparency: alpha.hasAlpha && alpha.transparentRatio > 0.3 && alpha.w === width && alpha.h === height,
      };
      report.shots.push({ file: `docs/shots/${file}`, width, height, alpha: { transparentRatio: +alpha.transparentRatio.toFixed(3) }, dom, checks });
      for (const [k, v] of Object.entries(checks)) report.checks.push({ shot: file, check: k, pass: v });
      console.log(`\n${file}  ${width}x${height}  transparent px: ${(alpha.transparentRatio * 100).toFixed(1)}%`);
      console.log(`  banner: "${dom.bannerText}"  combo: x${dom.comboN}  particles: ${dom.particles}  nodes: ${dom.nodes}  ticker: ${dom.tickerItems}`);
      console.log(`  leaderboard: ${dom.leaderboard.join(', ')}`);
      for (const [k, v] of Object.entries(checks)) console.log(`  ${v ? 'PASS' : 'FAIL'} ${k}`);
    };

    // Stop the random mock stream so every theme renders the same scripted scenario.
    await api(base, '/api/mock/stop', {});
    for (const theme of THEMES) await shoot(theme, 1080, 1920);
    await shoot('temple', 390, 693, '-390');

    // Control panel: must load cleanly and reach the server.
    currentShot = 'panel';
    await s('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    const panelLoaded = new Promise((r) => cdp.on((m) => m.method === 'Page.loadEventFired' && m.sessionId === sessionId && r()));
    await s('Page.navigate', { url: `${base}/panel` });
    await panelLoaded;
    for (let i = 0; i < 60 && !(await evaluate("/mode/.test(document.querySelector('#status').textContent)")); i++) await sleep(50);
    await sleep(300);
    await api(base, '/api/mock/emit', [{ type: 'comment', user: U.hoa, text: 'panel log check' }, gift(U.bao, G.corgi, 1, { streakable: false })]);
    await sleep(2500);
    const panel = await evaluate(`({
      status: document.querySelector('#status').textContent,
      giftOptions: document.querySelectorAll('#gift option').length,
      theme: document.querySelector('#theme').value,
      logLines: document.querySelectorAll('#log li').length,
    })`);
    await capture('panel.png', DARK);
    const panelChecks = {
      statusLoaded: /mode/.test(panel.status),
      giftListLoaded: panel.giftOptions > 0,
      configLoaded: panel.theme === 'temple',
      liveLogReceives: panel.logLines >= 2,
    };
    console.log(`\npanel.png  status: "${panel.status}"  log lines: ${panel.logLines}`);
    for (const [k, v] of Object.entries(panelChecks)) {
      report.checks.push({ shot: 'panel.png', check: k, pass: v });
      console.log(`  ${v ? 'PASS' : 'FAIL'} ${k}`);
    }

    await cdp.send('Target.closeTarget', { targetId });
  } finally {
    chrome?.proc.kill();
    server.kill();
    if (chrome?.userDir) {
      await sleep(300);
      rmSync(chrome.userDir, { recursive: true, force: true });
    }
  }

  writeFileSync(path.join(SHOTS, 'report.json'), JSON.stringify(report, null, 2));
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
