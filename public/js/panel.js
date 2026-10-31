// Operator control panel. Talks to /api/* with JSON; listens to /ws for a live log.

const $ = (s) => document.querySelector(s);
const LOG_MAX = 80;

async function api(path, body) {
  const res = await fetch(`/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!res.ok && json.ok !== false) json.ok = false;
  return json;
}

let toastTimer;
function toast(msg, isErr = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = isErr ? 'toast err' : 'toast';
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3500);
}

function showTikTok(t) {
  const el = $('#tiktok');
  el.className = t.state === 'error' ? 'err' : 'muted';
  el.textContent = `State: ${t.state}${t.username ? ` (@${t.username})` : ''}${t.roomId ? ` · room ${t.roomId}` : ''}${t.error ? ` — ${t.error}` : ''}`;
}

function showConfig(c) {
  $('#theme').value = c.theme;
  $('#ticker').checked = c.ticker;
  $('#muted').checked = c.muted;
  if (document.activeElement !== $('#template')) $('#template').value = c.template;
  $('#topN').value = c.topN;
}

async function refreshHealth() {
  const res = await fetch('/health').then((r) => r.json()).catch(() => null);
  const st = $('#status');
  if (!res) {
    st.textContent = 'server unreachable';
    st.className = 'status err';
    return;
  }
  st.className = 'status ok';
  st.textContent = `${res.mode} mode · ${res.clients} ws clients · mock ${res.mock.running ? `on @ ${res.mock.rate}/s` : 'off'} · events ${res.counters.emitted} emitted / ${res.counters.dropped} dropped`;
  showTikTok(res.tiktok);
}

async function setConfig(patch) {
  const r = await api('/config', patch);
  if (!r.ok) toast(r.error ?? 'config rejected', true);
  else showConfig(r.config);
}

function logLine(text) {
  const li = document.createElement('li');
  li.textContent = `${new Date().toLocaleTimeString()}  ${text}`;
  $('#log').prepend(li);
  while ($('#log').childElementCount > LOG_MAX) $('#log').lastElementChild.remove();
}

function describe(msg) {
  const d = msg.data;
  if (msg.kind === 'event') {
    if (d.type === 'gift') return `GIFT  ${d.user.name} → ${d.gift.name} ×${d.gift.comboCount} (#${d.gift.count}, ◆${d.gift.diamondTotal})`;
    if (d.type === 'comment') return `CHAT  ${d.user.name}: ${d.text}`;
    return `${d.type.toUpperCase().padEnd(5)} ${d.user.name}`;
  }
  if (msg.kind === 'status') return `TIKTOK ${d.state}${d.error ? ` — ${d.error}` : ''}`;
  if (msg.kind === 'clear') return 'STATE CLEARED';
  return null;
}

function listen() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.kind === 'hello' || msg.kind === 'config') showConfig(msg.data.config ?? msg.data);
    if (msg.kind === 'status') showTikTok(msg.data);
    const line = describe(msg);
    if (line) logLine(line);
  };
  ws.onclose = () => setTimeout(listen, 1500);
}

// ---- wire up controls ----
$('#connect-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = $('#username').value.trim();
  showTikTok({ state: 'connecting', username: username.replace(/^@/, '') });
  const r = await api('/connect', { username });
  if (r.tiktok) showTikTok(r.tiktok);
  if (!r.ok) toast(r.tiktok?.error ?? r.error ?? 'connect failed', true);
  else toast('Connected');
});
$('#disconnect').addEventListener('click', async () => showTikTok((await api('/disconnect', {})).tiktok));
$('#theme').addEventListener('change', (e) => setConfig({ theme: e.target.value }));
$('#ticker').addEventListener('change', (e) => setConfig({ ticker: e.target.checked }));
$('#muted').addEventListener('change', (e) => setConfig({ muted: e.target.checked }));
$('#save-template').addEventListener('click', () => setConfig({ template: $('#template').value }));
$('#topN').addEventListener('change', (e) => setConfig({ topN: Number(e.target.value) }));
$('#send-gift').addEventListener('click', async () => {
  const r = await api('/test-gift', { giftId: $('#gift').value });
  if (!r.ok) toast(r.error, true);
});
$('#mock-start').addEventListener('click', async () => {
  const r = await api('/mock/start', { rate: Number($('#rate').value) });
  toast(r.ok ? `Mock stream on @ ${r.mock.rate}/s` : r.error, !r.ok);
  refreshHealth();
});
$('#mock-stop').addEventListener('click', async () => {
  await api('/mock/stop', {});
  toast('Mock stream stopped');
  refreshHealth();
});
$('#clear').addEventListener('click', async () => {
  if (!confirm('Clear leaderboard, counters and on-screen state?')) return;
  const r = await api('/clear', {});
  toast(r.ok ? 'Session state cleared' : r.error, !r.ok);
});

const { gifts } = await api('/gifts');
for (const g of gifts) {
  const opt = document.createElement('option');
  opt.value = g.id;
  opt.textContent = `${g.name} (${g.diamond} diamonds)`;
  $('#gift').append(opt);
}
const state = await api('/state');
showConfig(state.config);
listen();
refreshHealth();
setInterval(refreshHealth, 2000);
