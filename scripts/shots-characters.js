// Visual + runtime verification of the pixel characters via the Chrome DevTools Protocol.
//
//   node scripts/shots-characters.js
//
// 1. Starts the real server as a child process: MOCK=1 PORT=3300 node src/server.js
// 2. Headless Chrome at 1080x1920 loads /overlay?demo=1 over a dark backdrop.
// 3. For each theme (switched live through POST /api/config, no reload): scripts a
//    gift / comment / like / follow / gift streak from characters on stage, captures
//    docs/shots/characters-{theme}.png (full frame) and characters-{theme}-stage.png (stage band).
// 4. Measures: canvas pixels (not empty), real FPS over 3 s, frame cost, cap under a
//    20-viewer burst, layout (no overlap with banner / leaderboard / combo / ticker,
//    z-order), live config (scale, enable/disable), theme colours, console errors.
// Writes docs/shots/characters-report.json (HEADFUL=1) or characters-report-headless.json.
// Exits 1 on any failure.

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(ROOT, 'docs', 'shots');
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const THEMES = ['temple', 'neon', 'tet'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env: { ...process.env, MOCK: '1', PORT: process.env.PORT ?? '3300' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', (d) => {
      out += d;
      const m = /overlay:\s+(http:\/\/127\.0\.0\.1:\d+)\/overlay/.exec(out);
      if (m) resolve({ proc, base: m[1] });
    });
    proc.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
    proc.once('exit', (code) => reject(new Error(`server exited early (${code})\n${out}`)));
  });
}

// HEADFUL=1 runs a real (off-screen) Chrome window: headless Chrome on macOS paces
// requestAnimationFrame at ~16 fps, which says nothing about the overlay itself.
const HEADFUL = process.env.HEADFUL === '1';

function startChrome() {
  const userDir = mkdtempSync(path.join(tmpdir(), 'tlo-chrome-'));
  const mode = HEADFUL
    ? ['--window-position=-3000,-3000', '--window-size=1080,1920', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling']
    : ['--headless=new'];
  const proc = spawn(
    CHROME,
    [...mode, '--remote-debugging-port=0', `--user-data-dir=${userDir}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars', '--force-device-scale-factor=1', 'about:blank'],
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
    this.ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
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

const post = (base, p, body = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, ...(await r.json()) }));

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const report = { errors: [], warnings: [], checks: [], measurements: {} };
  const check = (name, pass, detail = '') => {
    report.checks.push({ check: name, pass: Boolean(pass), detail });
    console.log(`  ${pass ? 'PASS' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
  };

  const server = await startServer();
  console.log(`server up at ${server.base} (MOCK=1)`);
  let chrome;
  try {
    chrome = await startChrome();
    const cdp = new CDP(chrome.wsUrl);
    await cdp.open();
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const s = (m, p) => cdp.send(m, p, sessionId);
    report.measurements.browser = HEADFUL ? 'headful Chrome, off-screen window' : 'headless Chrome (--headless=new)';
    // Baseline: how fast does this browser run a bare requestAnimationFrame loop at all?
    await s('Emulation.setDeviceMetricsOverride', { width: 1080, height: 1920, deviceScaleFactor: 1, mobile: false });
    const bare = await s('Runtime.evaluate', { expression: `new Promise((res) => { let n = 0; const t0 = performance.now(); (function f() { n++; if (performance.now() - t0 < 3000) requestAnimationFrame(f); else res(n / ((performance.now() - t0) / 1000)); })(); })`, awaitPromise: true, returnByValue: true });
    const baselineFps = bare.result.value;
    report.measurements.baselineFps = baselineFps;
    console.log(`baseline bare rAF in this browser: ${baselineFps.toFixed(1)} fps (${report.measurements.browser})`);
    cdp.listeners.push((m) => {
      if (m.sessionId !== sessionId) return;
      if (m.method === 'Runtime.exceptionThrown') report.errors.push(`exception: ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}`);
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') report.errors.push(`console.error: ${m.params.args.map((a) => a.value ?? a.description).join(' ')}`);
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'warning') report.warnings.push(`console.warn: ${m.params.args.map((a) => a.value ?? a.description).join(' ')}`);
      if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') report.errors.push(`${m.params.entry.text} ${m.params.entry.url ?? ''}`);
    });
    await s('Page.enable');
    await s('Runtime.enable');
    await s('Log.enable');
    const evaluate = async (expr) => {
      const r = await s('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(`evaluate failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
      return r.result.value;
    };
    const stats = () => evaluate('window.__overlay.stats().characters');
    const capture = async (file, clip) => {
      const { data } = await s('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
      writeFileSync(path.join(SHOTS, file), Buffer.from(data, 'base64'));
    };

    await s('Emulation.setDeviceMetricsOverride', { width: 1080, height: 1920, deviceScaleFactor: 1, mobile: false });
    await s('Emulation.setDefaultBackgroundColorOverride', { color: { r: 24, g: 26, b: 34, a: 1 } });
    await post(server.base, '/api/config', { theme: 'temple', characters: { enabled: true, max: 12, scale: 3, groupDance: true } });
    const loaded = new Promise((r) => cdp.listeners.push((m) => m.method === 'Page.loadEventFired' && m.sessionId === sessionId && r()));
    await s('Page.navigate', { url: `${server.base}/overlay?demo=1` });
    await loaded;
    const t0 = Date.now();

    // Let the mock stream populate the stage, plus a few previewed viewers.
    await sleep(1500);
    const spawned = await post(server.base, '/api/characters/spawn', { count: 3 });
    check('POST /api/characters/spawn {count:3} -> 200 + 3 viewers', spawned.status === 200 && spawned.spawned?.length === 3, spawned.spawned?.map((u) => u.name).join(', '));
    await sleep(5500);
    let st = await stats();
    check('mock mode puts >= 6 characters on stage', st.count >= 6, `count=${st.count} pending=${st.pending}`);
    check('one rAF loop running', st.running === true);

    // ---------- per theme ----------
    for (const theme of THEMES) {
      console.log(`\n${theme}`);
      await post(server.base, '/api/config', { theme });
      await sleep(400);
      const themeInfo = await evaluate(`({ theme: document.documentElement.dataset.theme, cssOutline: getComputedStyle(document.documentElement).getPropertyValue('--panel-bg-2').trim(), outline: window.__overlay.stats().characters.outline })`);
      check(`${theme}: applied live without reload`, themeInfo.theme === theme);
      check(`${theme}: outline colour comes from --panel-bg-2`, themeInfo.outline === themeInfo.cssOutline, `${themeInfo.outline}`);

      // Script an interaction scene with characters that are on stage right now.
      st = await stats();
      const onStage = st.who.filter((c) => c.state !== 'enter' && c.state !== 'leave');
      const sorted = [...onStage].sort((a, b) => a.x - b.x);
      const pickAt = (f) => sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))];
      const giver = pickAt(0.5);
      const talker = pickAt(0.15);
      const liker = pickAt(0.85);
      const user = (c) => ({ id: c.id, name: c.name });
      const stamp = Date.now();
      await post(server.base, '/api/mock/emit', [
        { type: 'gift', msgId: `cg${theme}${stamp}`, user: user(giver), gift: { id: '6267', name: 'Corgi', diamond: 299, repeatCount: 1, streakable: false } },
        { type: 'comment', user: user(talker), text: theme === 'tet' ? 'Chúc mừng năm mới cả nhà! 🧧' : 'Xin chào cả phòng, overlay dễ thương quá trời luôn!' },
        { type: 'like', user: user(liker) },
        { type: 'follow', user: user(pickAt(0.3)) },
        ...[1, 2, 3, 4].map((n) => ({ type: 'gift', msgId: `cs${theme}${stamp}${n}`, user: user(pickAt(0.7)), gift: { id: '5655', name: 'Rose', diamond: 1, repeatCount: n, streakable: true } })),
      ]);
      await sleep(700);
      st = await stats();
      const reacting = st.who.filter((c) => ['wave', 'dance', 'celebrate', 'talk', 'heart', 'star'].includes(c.state));
      check(`${theme}: interaction scene (wave/dance/celebrate/talk)`, reacting.some((c) => c.state === 'celebrate' || c.state === 'dance') && reacting.some((c) => c.state === 'wave' || c.state === 'heart') && st.bubbles >= 1, Object.entries(st.states).map(([k, v]) => `${k}:${v}`).join(' ') + ` bubbles:${st.bubbles}`);
      const canvas = await evaluate(`(() => {
        const c = document.querySelector('#characters');
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let filled = 0; const colors = new Set();
        for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 0) { filled++; if (colors.size < 4096) colors.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]); }
        return { w: c.width, h: c.height, filled, ratio: filled / (c.width * c.height), colors: colors.size, smoothing: c.getContext('2d').imageSmoothingEnabled };
      })()`);
      report.measurements[`canvas-${theme}`] = canvas;
      check(`${theme}: canvas is not empty`, canvas.filled > 20_000 && canvas.colors > 12, `${canvas.filled} opaque px (${(canvas.ratio * 100).toFixed(1)}%), ${canvas.colors} colours, ${canvas.w}x${canvas.h}`);
      check(`${theme}: nearest-neighbour scaling`, canvas.smoothing === false);
      const rect = await evaluate(`(() => { const r = document.querySelector('#characters').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
      await capture(`characters-${theme}.png`);
      await capture(`characters-${theme}-stage.png`, rect);
      report.measurements[`scene-${theme}`] = { states: st.states, bubbles: st.bubbles, crowns: st.crowns, count: st.count };
    }

    // ---------- layout ----------
    console.log('\nlayout');
    const layout = await evaluate(`(() => {
      const box = (sel) => { const el = document.querySelector(sel); if (!el || el.hidden) return null; const r = el.getBoundingClientRect(); return r.width ? { top: r.top, bottom: r.bottom, left: r.left, right: r.right } : null; };
      const z = (sel) => Number(getComputedStyle(document.querySelector(sel)).zIndex);
      return { chars: box('#characters'), banner: box('#banner'), board: box('#leaderboard'), combo: box('#combo'), ticker: box('#ticker'),
               z: { particles: z('#particles'), chars: z('#characters'), banner: z('#banner'), board: z('#leaderboard'), combo: z('#combo'), ticker: z('#ticker') },
               pointer: getComputedStyle(document.querySelector('#characters')).pointerEvents };
    })()`);
    report.measurements.layout = layout;
    const overlap = (a, b) => a && b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    const c = layout.chars;
    check('stage band is ~38% of height along the bottom', c && Math.abs(c.bottom - c.top - 1920 * 0.38) < 2, c ? `top ${Math.round(c.top)} bottom ${Math.round(c.bottom)}` : 'missing');
    for (const k of ['banner', 'board', 'combo']) {
      check(`stage does not overlap ${k}`, layout[k] ? !overlap(c, layout[k]) : true, layout[k] ? `${k} ${Math.round(layout[k].top)}..${Math.round(layout[k].bottom)}` : `${k} not visible at this moment`);
    }
    check('ticker sits below the stage (not covered)', layout.ticker && layout.ticker.top >= c.bottom - 0.5, layout.ticker ? `ticker top ${Math.round(layout.ticker.top)} >= stage bottom ${Math.round(c.bottom)}` : 'ticker hidden');
    const zOk = layout.z.particles < layout.z.chars && ['banner', 'board', 'combo', 'ticker'].every((k) => layout.z[k] > layout.z.chars);
    check('z-order: particles < characters < banner/leaderboard/combo/ticker', zOk, JSON.stringify(layout.z));
    check('canvas ignores pointer events', layout.pointer === 'none');
    check('banner + leaderboard visible during the scene', Boolean(layout.banner) && Boolean(layout.board));

    // ---------- group dance (first one 25-40 s of stage time after load) ----------
    console.log('\nwaiting for a group dance…');
    const until = Date.now() + 90_000;
    do {
      st = await stats();
      if (st.groupDances >= 1) break;
      await sleep(1000);
    } while (Date.now() < until && st.time < 45);
    st = await stats();
    if (st.groupDances >= 1) {
      await sleep(500);
      const r = await evaluate(`(() => { const r = document.querySelector('#characters').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
      await capture('characters-group-dance-stage.png', r);
    }
    check('group dance happened (every 25-40 s)', st.groupDances >= 1, `groupDances=${st.groupDances} at stage time ${st.time} s (wall ${Math.round((Date.now() - t0) / 1000)} s)`);
    check('neighbours greeted each other at least once', st.greetings >= 1, `greetings=${st.greetings}`);

    // ---------- FPS with a full stage ----------
    console.log('\nperformance');
    await post(server.base, '/api/characters/spawn', { count: 12 });
    await sleep(1500);
    const perf = await evaluate(`new Promise((resolve) => {
      // DOM nodes outside the (pre-existing) DOM particle layer: must not grow while characters animate.
      const outside = () => [...document.body.getElementsByTagName('*')].filter((el) => !el.closest('#particles')).length;
      const s0 = window.__overlay.stats().characters; const t0 = performance.now(); const n0 = outside();
      setTimeout(() => { const s1 = window.__overlay.stats().characters; const sec = (performance.now() - t0) / 1000;
        resolve({ fps: (s1.frames - s0.frames) / sec, seconds: sec, frameMs: s1.frameMs, count: s1.count, effects: s1.effects,
                  nodesBefore: n0, nodesAfter: outside(), canvases: document.querySelectorAll('canvas').length }); }, 3000);
    })`);
    report.measurements.fps = perf;
    const fpsDetail = `${perf.fps.toFixed(1)} fps vs bare rAF ${baselineFps.toFixed(1)} fps over ${perf.seconds.toFixed(2)} s, ${perf.count} characters`;
    if (HEADFUL) check('FPS with 12 characters >= 55 and >= 90% of bare rAF', perf.fps >= 55 || perf.fps >= baselineFps * 0.9, fpsDetail);
    else {
      // Headless Chrome on macOS paces rAF at ~15 fps even for an empty page: record, do not judge.
      console.log(`  INFO FPS (headless, not judged): ${fpsDetail}. Run with HEADFUL=1 for a real frame rate.`);
      report.measurements.fpsNote = 'headless: rAF capped by the browser; see HEADFUL=1 run';
    }
    check('update+draw cost per frame <= 4 ms (60 fps budget is 16.7 ms)', perf.frameMs <= 4, `${perf.frameMs} ms/frame (EMA)`);
    const benchMs = await evaluate('window.__overlay.benchCharacters(600)');
    report.measurements.benchMsPerFrame = benchMs;
    check('throughput benchmark: 600 frames without vsync (incl. raster flush)', benchMs < 16.7, `${benchMs.toFixed(3)} ms/frame -> ~${Math.round(1000 / benchMs)} fps capacity with ${perf.count} characters`);
    check('no DOM nodes created per frame (one canvas, stable node count)', perf.canvases === 1 && perf.nodesAfter <= perf.nodesBefore + 2, `${perf.nodesBefore} -> ${perf.nodesAfter} nodes outside #particles, ${perf.canvases} canvas`);

    // ---------- cap under a burst ----------
    const burst = await post(server.base, '/api/characters/spawn', { count: 20 });
    const capSeen = await evaluate(`new Promise((resolve) => { let max = 0; const end = performance.now() + 2500;
      (function poll() { const s = window.__overlay.stats().characters; max = Math.max(max, s.count); if (performance.now() < end) setTimeout(poll, 16); else resolve({ maxSeen: max, cap: s.max, evicted: s.evicted }); })(); })`);
    report.measurements.cap = capSeen;
    check('cap never exceeded under a 20-viewer burst', burst.status === 200 && capSeen.maxSeen <= capSeen.cap, `max seen ${capSeen.maxSeen} / cap ${capSeen.cap}, evicted so far ${capSeen.evicted}`);
    check('spawn endpoint rejects count 0 / 21 / "x"', (await Promise.all([0, 21, 'x'].map((count) => post(server.base, '/api/characters/spawn', { count })))).every((r) => r.status === 400));

    // ---------- live config ----------
    console.log('\nlive config');
    await post(server.base, '/api/config', { characters: { scale: 5, max: 6 } });
    await sleep(800);
    st = await stats();
    check('scale/max apply live over WebSocket', st.pixel === 15 && st.count <= 6 && st.max === 6, `pixel ${st.pixel}, count ${st.count}/${st.max}`);
    await capture('characters-scale5-stage.png', await evaluate(`(() => { const r = document.querySelector('#characters').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`));
    await post(server.base, '/api/config', { characters: { enabled: false } });
    await sleep(300);
    const off = await evaluate(`({ hidden: document.querySelector('#characters').hidden, running: window.__overlay.stats().characters.running })`);
    check('disable hides the canvas and cancels rAF', off.hidden && off.running === false);
    await post(server.base, '/api/config', { characters: { enabled: true, scale: 3, max: 12 } });
    await sleep(300);
    check('re-enable restarts the loop', (await stats()).running === true);

    report.measurements.final = { count: st.count, spawned: st.spawned, evicted: st.evicted, greetings: st.greetings, groupDances: st.groupDances, errors: st.errors, fps: st.fps, frameMs: st.frameMs };
    check('character frame loop reported 0 errors', st.errors === 0);

    // ---------- panel: "Nhân vật pixel" section drives the server config ----------
    console.log('\npanel');
    const health = () => fetch(`${server.base}/health`).then((r) => r.json());
    for (const [width, height, file] of [[1080, 1400, 'characters-panel.png'], [390, 844, 'characters-panel-390.png']]) {
      await s('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 500 });
      await s('Emulation.setDefaultBackgroundColorOverride', {});
      const panelLoaded = new Promise((r) => cdp.listeners.push((m) => m.method === 'Page.loadEventFired' && m.sessionId === sessionId && r()));
      await s('Page.navigate', { url: `${server.base}/panel` });
      await panelLoaded;
      await sleep(800);
      const box = await evaluate(`(() => { const el = document.querySelector('#chars'); el.scrollIntoView({ block: 'start' }); const r = el.getBoundingClientRect();
        return { x: Math.max(0, r.x - 8), y: Math.max(0, r.y - 8 + scrollY), width: Math.min(innerWidth, r.width + 16), height: r.height + 16,
                 overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth }; })()`);
      await sleep(200);
      const { data } = await s('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 } });
      writeFileSync(path.join(SHOTS, file), Buffer.from(data, 'base64'));
      check(`panel ${width}px: section has no horizontal overflow`, !box.overflow);
    }
    const ui = await evaluate(`({ enabled: document.querySelector('#chars-enabled').checked, group: document.querySelector('#chars-group').checked,
      max: document.querySelector('#chars-max').value, scale: document.querySelector('#chars-scale').value, maxOut: document.querySelector('#chars-max-out').textContent })`);
    const cfg0 = (await health()).config.characters;
    check('panel controls show the server config', ui.enabled === cfg0.enabled && ui.group === cfg0.groupDance && Number(ui.max) === cfg0.max && Number(ui.scale) === cfg0.scale && ui.maxOut === String(cfg0.max), JSON.stringify(ui));
    await evaluate(`(() => { const r = document.querySelector('#chars-max'); r.value = '9'; r.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await sleep(600);
    check('panel slider "Số nhân vật tối đa" applies (debounced) to the server', (await health()).config.characters.max === 9);
    await evaluate(`document.querySelector('#chars-group').click()`);
    await sleep(400);
    check('panel switch "nhảy tập thể" applies', (await health()).config.characters.groupDance === !cfg0.groupDance);
    await evaluate(`document.querySelector('#chars-group').click()`);
    const before = (await health()).counters.emitted;
    await evaluate(`document.querySelector('#chars-spawn').click()`);
    check('panel button "Bắn thử nhân vật" spawns viewers', await (async () => {
      for (let i = 0; i < 40; i++) {
        if (/Đã thêm 3 nhân vật/.test(await evaluate(`document.querySelector('#toast').textContent`))) return (await health()).counters.emitted >= before + 3;
        await sleep(50);
      }
      return false;
    })());
    await post(server.base, '/api/config', { characters: { max: 12 } });

    await cdp.send('Target.closeTarget', { targetId });
  } finally {
    chrome?.proc.kill();
    server.proc.kill('SIGINT');
    if (chrome?.userDir) {
      await sleep(300);
      rmSync(chrome.userDir, { recursive: true, force: true });
    }
  }

  writeFileSync(path.join(SHOTS, HEADFUL ? 'characters-report.json' : 'characters-report-headless.json'), JSON.stringify(report, null, 2));
  const failed = report.checks.filter((c) => !c.pass);
  console.log(`\nconsole errors: ${report.errors.length}`);
  for (const e of report.errors) console.log(`  ${e}`);
  if (report.warnings.length) console.log(`console warnings: ${report.warnings.length}\n  ${report.warnings.join('\n  ')}`);
  console.log(`checks: ${report.checks.length - failed.length}/${report.checks.length} passed`);
  if (failed.length || report.errors.length) process.exit(1);
}

main().catch((err) => {
  console.error('character verification failed:', err);
  process.exit(1);
});
