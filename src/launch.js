// One-click launcher used by BAT-DAU.command (macOS) and BAT-DAU.bat (Windows).
//
//   node src/launch.js [--no-open] [--port=3000] [--mock]
//
// Picks a free port (3000, 3001, ...), starts the server, waits for /health,
// opens the control panel in the default browser and prints a Vietnamese banner
// with the overlay URL to paste into OBS. Ctrl-C / closing the window shuts down cleanly.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOverlayServer } from './server.js';
import { listenOnFreePort } from './port.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_START_PORT = 3000;
export const SETTINGS_FILE = path.join(ROOT, 'data', 'settings.json');

/** Parse launcher flags/env into options. Pure. */
export function parseLauncherArgs(argv = [], env = {}) {
  const opts = { open: true, port: DEFAULT_START_PORT, mock: false };
  if (env.PORT !== undefined && env.PORT !== '') opts.port = Number(env.PORT);
  if (env.MOCK === '1' || env.MOCK === 'true') opts.mock = true;
  if (env.NO_OPEN === '1') opts.open = false;
  for (const arg of argv) {
    if (arg === '--no-open') opts.open = false;
    else if (arg === '--mock') opts.mock = true;
    else if (arg.startsWith('--port=')) opts.port = Number(arg.slice('--port='.length));
  }
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) opts.port = DEFAULT_START_PORT;
  return opts;
}

/** Command that opens `url` in the default browser for this platform. Pure. */
export function openCommand(url, platform = process.platform) {
  if (platform === 'darwin') return { cmd: 'open', args: [url] };
  // `start` is a cmd.exe builtin; the empty "" is the window title argument.
  if (platform === 'win32') return { cmd: 'cmd', args: ['/c', 'start', '""', url], verbatim: true };
  return { cmd: 'xdg-open', args: [url] };
}

function openInBrowser(url) {
  return new Promise((resolve) => {
    const { cmd, args, verbatim = false } = openCommand(url);
    try {
      const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true, windowsVerbatimArguments: verbatim });
      child.once('error', () => resolve(false));
      child.once('spawn', () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}

/** Poll `url` until it answers 200 with { ok: true }. */
export async function waitForHealth(url, { timeoutMs = 15_000, intervalMs = 150 } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok && (await res.json()).ok === true) return true;
    } catch {
      /* not up yet */
    }
    if (Date.now() > end) throw new Error(`server did not answer ${url} within ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * Start everything. Returns handles so tests can drive it with { open: false }.
 * @param {object} [o]
 * @param {number}  [o.port]          preferred first port
 * @param {boolean} [o.open]          open the panel in a browser
 * @param {boolean} [o.mock]
 * @param {string}  [o.settingsPath]
 * @param {object}  [o.logger]
 * @param {(url:string) => Promise<boolean>} [o.openUrl]
 */
export async function launch({ port = DEFAULT_START_PORT, open = true, mock = false, settingsPath, logger = console, openUrl = openInBrowser } = {}) {
  const host = '127.0.0.1';
  const app = createOverlayServer({ mock, host, settingsPath, logger });
  const { url, port: chosen } = await listenOnFreePort(app, port, { host });
  await waitForHealth(`${url}/health`);
  const urls = { base: url, panel: `${url}/panel`, overlay: `${url}/overlay` };
  const opened = open ? await openUrl(urls.panel) : false;
  return { app, port: chosen, urls, opened, close: () => app.close() };
}

export function banner({ port, urls, opened, preferredPort, mock }) {
  const line = '='.repeat(64);
  return [
    '',
    line,
    '   ĐANG CHẠY!  ĐỪNG ĐÓNG CỬA SỔ NÀY khi bạn đang LIVE.',
    line,
    '',
    `   Bảng điều khiển:  ${urls.panel}`,
    opened ? '   (đã tự mở trong trình duyệt)' : '   (hãy mở đường dẫn trên trong trình duyệt)',
    '',
    '   Dán đường dẫn này vào OBS (Nguồn > Trình duyệt > URL):',
    '',
    `      ${urls.overlay}`,
    '',
    port !== preferredPort ? `   Lưu ý: cổng ${preferredPort} đang bận nên đã dùng cổng ${port}.` : null,
    mock ? '   Chế độ thử nghiệm: đang phát quà giả để xem thử.' : null,
    '   Muốn tắt: bấm Ctrl + C, hoặc đóng cửa sổ này.',
    line,
    '',
  ]
    .filter((l) => l !== null)
    .join('\n');
}

// ---- CLI entry -------------------------------------------------------------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const opts = parseLauncherArgs(process.argv.slice(2), process.env);
  process.on('unhandledRejection', (err) => console.error('[process] unhandled rejection', err));
  process.on('uncaughtException', (err) => console.error('[process] uncaught exception', err));

  console.log('Đang khởi động, vui lòng đợi...');
  let running;
  try {
    running = await launch({ ...opts, settingsPath: SETTINGS_FILE });
  } catch (err) {
    console.error('\nKHÔNG KHỞI ĐỘNG ĐƯỢC CHƯƠNG TRÌNH.');
    console.error('Hãy đóng cửa sổ này và mở lại BAT-DAU. Nếu vẫn lỗi, gửi dòng dưới đây cho người hỗ trợ:');
    console.error(`  ${err?.message ?? err}`);
    process.exit(1);
  }
  console.log(banner({ ...running, preferredPort: opts.port, mock: opts.mock }));

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`\nĐang tắt chương trình (${signal})...`);
    const force = setTimeout(() => process.exit(0), 5000);
    force.unref();
    try {
      await running.close();
    } catch (err) {
      console.error('[launch] error while closing', err);
    }
    console.log('Đã tắt. Bạn có thể đóng cửa sổ này.');
    process.exit(0);
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => shutdown(sig));
}
