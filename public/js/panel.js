// Beginner-friendly control panel: 3 guided steps + a collapsed "Nâng cao" section.
// Talks to /api/* with JSON and listens to /ws. All user-facing text is Vietnamese;
// raw server errors are never shown - they are mapped through messages.js.

import { friendlyError, describeConnection, cleanUsername } from './messages.js';
import { TEMPLATE_VARS } from './template.js';

const $ = (s) => document.querySelector(s);
const LOG_MAX = 80;
const USERNAME_KEY = 'tlo.username';
const THEME_NAMES = { temple: 'Chùa', neon: 'Neon', tet: 'Tết' };

async function api(path, body) {
  try {
    const res = await fetch(`/api${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({ ok: false }));
    if (!res.ok) json.ok = false;
    return json;
  } catch {
    return { ok: false, errorCode: 'server_unreachable' };
  }
}

let toastTimer;
function toast(msg, isErr = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = isErr ? 'toast toast--err' : 'toast';
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4000);
}

// ---------- step 1: connection ----------
let lastStatus = { state: 'idle' };
let lastServerSince = null; // `since` of the last server-sent status; local-only statuses have none
function showConnection(status) {
  lastStatus = status ?? { state: 'idle' };
  if (lastStatus.since !== undefined) lastServerSince = lastStatus.since;
  const d = describeConnection(lastStatus);
  const el = $('#conn-status');
  el.dataset.tone = d.tone;
  el.textContent = d.text;
  $('#retry').hidden = !d.canRetry;
  $('#disconnect').hidden = !d.connected;
  $('#connect').disabled = d.tone === 'busy';
  $('#connect').textContent = d.tone === 'busy' ? 'Đang kết nối…' : 'Kết nối';
}

async function connect(rawName) {
  const username = cleanUsername(rawName);
  if (!username) {
    showConnection({ state: 'error', errorCode: 'invalid_username' });
    $('#username').focus();
    return;
  }
  try {
    localStorage.setItem(USERNAME_KEY, username);
  } catch {
    /* private mode */
  }
  showConnection({ state: 'connecting', username });
  const r = await api('/connect', { username });
  if (r.tiktok) showConnection(r.tiktok);
  else if (!r.ok) showConnection({ state: 'error', errorCode: r.errorCode, username });
}

// ---------- step 2: themes ----------
function showTheme(theme) {
  for (const input of document.querySelectorAll('input[name="theme"]')) {
    input.checked = input.value === theme;
    input.closest('.theme-card').classList.toggle('is-selected', input.checked);
  }
}

// ---------- step 3: overlay URL + copy ----------
const overlayUrl = () => `${location.origin}/overlay`;

async function copyUrl() {
  const box = $('#overlay-url');
  const text = box.value;
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    // Fallback for browsers/contexts without the async Clipboard API.
    box.focus();
    box.select();
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
  }
  const btn = $('#copy');
  if (ok) {
    btn.textContent = 'Đã sao chép ✓';
    $('#copy-status').textContent = 'Đã sao chép! Giờ mở OBS và dán vào ô URL.';
    setTimeout(() => (btn.textContent = 'Sao chép'), 2500);
  } else {
    box.focus();
    box.select();
    $('#copy-status').textContent = 'Chưa sao chép được tự động. Đường dẫn đã được bôi đen — hãy bấm Ctrl+C (Mac: ⌘+C).';
  }
}

// ---------- advanced ----------
function showConfig(c) {
  if (!c) return;
  showTheme(c.theme);
  $('#ticker').checked = c.ticker;
  $('#muted').checked = c.muted;
  if (document.activeElement !== $('#template')) $('#template').value = c.template;
  $('#topN').value = c.topN;
  if (c.characters) {
    $('#chars-enabled').checked = c.characters.enabled;
    $('#chars-group').checked = c.characters.groupDance;
    for (const [id, key] of [['chars-max', 'max'], ['chars-scale', 'scale']]) {
      if (document.activeElement !== $(`#${id}`)) $(`#${id}`).value = c.characters[key];
      $(`#${id}-out`).textContent = $(`#${id}`).value;
    }
  }
}

async function setConfig(patch, okMsg) {
  const r = await api('/config', patch);
  if (!r.ok) {
    toast(r.errorCode === 'server_unreachable' ? friendlyError('server_unreachable') : friendlyError('config_rejected'), true);
    return false;
  }
  showConfig(r.config);
  if (okMsg) toast(okMsg);
  return true;
}

async function refreshHealth() {
  const res = await fetch('/health').then((r) => r.json()).catch(() => null);
  const st = $('#status');
  if (!res) {
    st.dataset.tone = 'error';
    st.textContent = friendlyError('server_unreachable');
    return;
  }
  st.dataset.tone = 'ok';
  st.textContent = `● Đang chạy · cổng ${res.port ?? location.port}`;
  $('#mock-note').hidden = res.mode !== 'mock';
  $('#stats').textContent = `Đã nhận ${res.counters.emitted} sự kiện · ${res.clients} màn hình đang mở · quà giả ${res.mock.running ? `đang bật (${res.mock.rate}/giây)` : 'tắt'}`;
  // Only react to real server-side changes, so a local message (e.g. invalid name) stays visible.
  if (res.tiktok && res.tiktok.since !== lastServerSince) showConnection(res.tiktok);
}

const TYPE_LABEL = { comment: 'BÌNH LUẬN', like: 'THẢ TIM', join: 'VÀO PHÒNG', follow: 'THEO DÕI', share: 'CHIA SẺ' };
function describe(msg) {
  const d = msg.data;
  if (msg.kind === 'event') {
    if (d.type === 'gift') return `QUÀ  ${d.user.name} → ${d.gift.name} ×${d.gift.comboCount} (lần ${d.gift.count}, ◆${d.gift.diamondTotal})`;
    if (d.type === 'comment') return `BÌNH LUẬN  ${d.user.name}: ${d.text}`;
    return `${TYPE_LABEL[d.type] ?? d.type}  ${d.user.name}`;
  }
  if (msg.kind === 'status') return `TIKTOK  ${describeConnection(d).text}`;
  if (msg.kind === 'clear') return 'ĐÃ XÓA DỮ LIỆU';
  return null;
}

function logLine(text) {
  const li = document.createElement('li');
  li.textContent = `${new Date().toLocaleTimeString('vi-VN')}  ${text}`;
  $('#log').prepend(li);
  while ($('#log').childElementCount > LOG_MAX) $('#log').lastElementChild.remove();
}

function listen() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (msg.kind === 'hello') {
      showConfig(msg.data.config);
      if (msg.data.tiktok) showConnection(msg.data.tiktok);
    }
    if (msg.kind === 'config') showConfig(msg.data);
    if (msg.kind === 'status') showConnection(msg.data);
    const line = describe(msg);
    if (line) logLine(line);
  };
  ws.onclose = () => setTimeout(listen, 1500);
}

// ---------- wire up ----------
$('#connect-form').addEventListener('submit', (e) => {
  e.preventDefault();
  connect($('#username').value);
});
$('#retry').addEventListener('click', () => connect($('#username').value || lastStatus.username || ''));
$('#disconnect').addEventListener('click', async () => {
  const r = await api('/disconnect', {});
  showConnection(r.tiktok ?? { state: 'idle' });
});
$('#test-gift').addEventListener('click', async () => {
  const r = await api('/test-gift', {});
  if (r.ok) toast(`Đã bắn quà thử: ${r.gift.name}! Xem trong OBS hoặc trang hiệu ứng.`);
  else toast(friendlyError(r.errorCode === 'server_unreachable' ? 'server_unreachable' : undefined), true);
});
for (const input of document.querySelectorAll('input[name="theme"]')) {
  input.addEventListener('change', async () => {
    showTheme(input.value);
    if (await setConfig({ theme: input.value })) $('#theme-status').textContent = `Đã chọn giao diện “${THEME_NAMES[input.value]}”.`;
  });
}
$('#copy').addEventListener('click', copyUrl);
$('#overlay-url').addEventListener('focus', (e) => e.target.select());

$('#ticker').addEventListener('change', (e) => setConfig({ ticker: e.target.checked }));
$('#muted').addEventListener('change', (e) => setConfig({ muted: e.target.checked }));
$('#save-template').addEventListener('click', () => setConfig({ template: $('#template').value }, 'Đã lưu mẫu câu.'));
$('#topN').addEventListener('change', (e) => setConfig({ topN: Number(e.target.value) }));

// ---------- API key for the signature provider (advanced) ----------
async function refreshSignKey() {
  const el = $('#signkey-status');
  if (!el) return;
  const r = await api('/signkey');
  if (!r || !r.ok) {
    el.textContent = '';
    return;
  }
  el.textContent = r.set
    ? `Đã lưu key (${r.hint}). Nếu Bước 1 đang báo lỗi, bấm “Thử lại”.`
    : 'Chưa có API key. Chỉ cần nhập khi gặp lỗi “hết lượt miễn phí”.';
}
const saveSignKeyBtn = $('#save-signkey');
if (saveSignKeyBtn) {
  saveSignKeyBtn.addEventListener('click', async () => {
    const key = $('#signkey').value.trim();
    const r = await api('/signkey', { key });
    if (!r.ok) {
      toast(r.error || 'Không lưu được API key. Hãy kiểm tra lại key đã sao chép đúng chưa.', true);
      return;
    }
    $('#signkey').value = '';
    toast(r.set ? 'Đã lưu API key. Bấm “Thử lại” ở Bước 1 để kết nối.' : 'Đã xoá API key.');
    refreshSignKey();
  });
  refreshSignKey();
}
// Pixel characters: switches apply on change, sliders apply live while dragging (debounced).
$('#chars-enabled').addEventListener('change', (e) => setConfig({ characters: { enabled: e.target.checked } }));
$('#chars-group').addEventListener('change', (e) => setConfig({ characters: { groupDance: e.target.checked } }));
for (const [id, key] of [['chars-max', 'max'], ['chars-scale', 'scale']]) {
  let timer;
  $(`#${id}`).addEventListener('input', (e) => {
    $(`#${id}-out`).textContent = e.target.value;
    clearTimeout(timer);
    timer = setTimeout(() => setConfig({ characters: { [key]: Number(e.target.value) } }), 150);
  });
}
$('#chars-spawn').addEventListener('click', async () => {
  const r = await api('/characters/spawn', { count: 3 });
  if (r.ok) toast(`Đã thêm ${r.spawned.length} nhân vật: ${r.spawned.map((u) => u.name).join(', ')}`);
  else toast(r.errorCode === 'server_unreachable' ? friendlyError('server_unreachable') : 'Chưa thêm được nhân vật. Hãy thử lại.', true);
});
$('#send-gift').addEventListener('click', async () => {
  const r = await api('/test-gift', { giftId: $('#gift').value });
  if (!r.ok) toast(friendlyError(r.errorCode), true);
});
$('#mock-start').addEventListener('click', async () => {
  const r = await api('/mock/start', { rate: Number($('#rate').value) });
  toast(r.ok ? `Đã bật quà giả: ${r.mock.rate} sự kiện/giây` : 'Số sự kiện mỗi giây phải từ 0,2 đến 50.', !r.ok);
  refreshHealth();
});
$('#mock-stop').addEventListener('click', async () => {
  await api('/mock/stop', {});
  toast('Đã dừng quà giả.');
  refreshHealth();
});
$('#clear').addEventListener('click', async () => {
  if (!confirm('Xóa bảng xếp hạng, bộ đếm và mọi thứ đang hiện trên màn hình?')) return;
  const r = await api('/clear', {});
  toast(r.ok ? 'Đã xóa dữ liệu buổi live.' : friendlyError(r.errorCode), !r.ok);
});

// ---------- boot ----------
$('#overlay-url').value = overlayUrl();
$('#open-overlay').href = '/overlay';
$('#template-vars').textContent = `(có thể dùng: ${TEMPLATE_VARS.map((v) => `{${v}}`).join(' ')})`;
try {
  $('#username').value = localStorage.getItem(USERNAME_KEY) ? `@${localStorage.getItem(USERNAME_KEY)}` : '';
} catch {
  /* private mode */
}
showConnection({ state: 'idle' });

const [giftRes, state] = await Promise.all([api('/gifts'), api('/state')]);
for (const g of giftRes.gifts ?? []) {
  const opt = document.createElement('option');
  opt.value = g.id;
  opt.textContent = `${g.name} (${g.diamond} kim cương)`;
  $('#gift').append(opt);
}
showConfig(state.config);
await refreshHealth();
$('#port-note').textContent = `Chương trình đang dùng cổng ${location.port || '80'}. Nếu lần sau cổng thay đổi, hãy dán lại đường dẫn mới vào OBS.`;
listen();
setInterval(refreshHealth, 2000);
