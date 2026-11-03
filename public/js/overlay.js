// Overlay client: subscribes to /ws and renders banner, leaderboard,
// particles, combo counter and comment ticker. All user-supplied strings are
// written with textContent - never innerHTML.

import { BannerQueue } from './banner-queue.js';
import { renderTemplate, bannerVars, VI_TEMPLATE } from './template.js';
import { Particles } from './particles.js';
import { waitingHintVisible, isActivity, isDemo } from './waiting.js';
import { CharacterLayer, CHARACTER_DEFAULTS } from './characters.js';

const THEMES = ['temple', 'neon', 'tet'];
const TICKER_MAX = 4;
const COMBO_LINGER_MS = 1600;
const MAX_DOM_NODES = 600;

const $ = (sel) => document.querySelector(sel);
const params = new URLSearchParams(location.search);
// URL params lock settings per Browser Source (e.g. /overlay?theme=neon&ticker=0).
const locked = {
  theme: THEMES.includes(params.get('theme')) ? params.get('theme') : null,
  ticker: params.has('ticker') ? params.get('ticker') !== '0' : null,
  muted: params.has('muted') ? params.get('muted') !== '0' : null,
  characters: params.has('characters') ? params.get('characters') !== '0' : null,
};

const state = {
  config: { theme: 'temple', ticker: true, muted: false, template: VI_TEMPLATE, characters: { ...CHARACTER_DEFAULTS } },
  combos: new Map(), // key -> { comboCount, user, gift, lastAt }
  comboKey: null,
  comboHideTimer: null,
};

// ---------- helpers ----------
function initials(name) {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  const s = parts.length > 1 ? parts[0][0] + parts.at(-1)[0] : (parts[0] ?? '?').slice(0, 2);
  return s.toUpperCase();
}

function fillAvatar(el, user) {
  el.replaceChildren();
  const fallback = () => {
    el.replaceChildren();
    el.textContent = initials(user.name);
  };
  if (user.avatarUrl) {
    const img = new Image();
    img.alt = '';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.onerror = fallback;
    img.src = user.avatarUrl;
    el.appendChild(img);
  } else {
    fallback();
  }
}

const fmt = new Intl.NumberFormat('vi-VN');

// ---------- config / theme ----------
function applyConfig(cfg) {
  state.config = { ...state.config, ...cfg };
  const theme = locked.theme ?? state.config.theme;
  const nextTheme = THEMES.includes(theme) ? theme : 'temple';
  const themeChanged = document.documentElement.dataset.theme !== nextTheme;
  document.documentElement.dataset.theme = nextTheme;
  if (characters) {
    if (themeChanged) characters.refreshTheme();
    const c = { ...CHARACTER_DEFAULTS, ...state.config.characters };
    characters.configure({ ...c, enabled: locked.characters ?? c.enabled });
  }
  const ticker = locked.ticker ?? state.config.ticker;
  $('#ticker').hidden = !ticker || $('#ticker .ticker__list').childElementCount === 0;
}
const muted = () => locked.muted ?? state.config.muted;

// ---------- sound (synthesized, no assets) ----------
let audio = null;
function chime(diamonds) {
  if (muted()) return;
  try {
    audio ??= new AudioContext();
    if (audio.state === 'suspended') audio.resume();
    const t = audio.currentTime;
    const notes = diamonds >= 1000 ? [523, 659, 784, 1047] : diamonds >= 100 ? [659, 784, 988] : [784, 1047];
    notes.forEach((f, i) => {
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.type = 'triangle';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + i * 0.09);
      g.gain.exponentialRampToValueAtTime(0.12, t + i * 0.09 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.09 + 0.5);
      o.connect(g).connect(audio.destination);
      o.start(t + i * 0.09);
      o.stop(t + i * 0.09 + 0.55);
    });
  } catch {
    /* audio is optional */
  }
}

// ---------- 1. banner ----------
const bannerEl = $('#banner');
const banners = new BannerQueue({
  show(ev) {
    fillAvatar(bannerEl.querySelector('.banner__avatar'), ev.user);
    bannerEl.querySelector('.banner__text').textContent = renderTemplate(state.config.template || VI_TEMPLATE, bannerVars(ev));
    bannerEl.querySelector('.banner__sub').textContent = `◆ ${fmt.format(ev.gift.diamondTotal)} kim cương`;
    bannerEl.hidden = false;
    bannerEl.classList.remove('is-out');
    void bannerEl.offsetWidth; // restart animation
    bannerEl.classList.add('is-in');
  },
  hide() {
    bannerEl.classList.remove('is-in');
    bannerEl.classList.add('is-out');
  },
});
bannerEl.addEventListener('animationend', (e) => {
  if (e.animationName === 'banner-out' && banners.current === null) bannerEl.hidden = true;
});

// ---------- 2. leaderboard (FLIP reorder) ----------
const boardEl = $('#leaderboard');
const boardList = boardEl.querySelector('.board__list');

function renderLeaderboard(rows) {
  // First: record positions of existing rows.
  const before = new Map();
  for (const li of boardList.children) before.set(li.dataset.user, li.getBoundingClientRect().top);

  const existing = new Map([...boardList.children].map((li) => [li.dataset.user, li]));
  const next = rows.map((r) => {
    let li = existing.get(r.userId);
    if (!li) {
      li = document.createElement('li');
      li.className = 'board__row';
      li.dataset.user = r.userId;
      const rank = document.createElement('span');
      rank.className = 'board__rank';
      const av = document.createElement('span');
      av.className = 'avatar';
      const name = document.createElement('span');
      name.className = 'board__name';
      const total = document.createElement('span');
      total.className = 'board__total';
      li.append(rank, av, name, total);
    }
    li.dataset.rank = String(r.rank);
    li.querySelector('.board__rank').textContent = String(r.rank);
    if (li.dataset.avatar !== r.avatarUrl || li.dataset.name !== r.name) {
      fillAvatar(li.querySelector('.avatar'), { name: r.name, avatarUrl: r.avatarUrl });
      li.dataset.avatar = r.avatarUrl;
      li.dataset.name = r.name;
    }
    li.querySelector('.board__name').textContent = r.name;
    li.querySelector('.board__total').textContent = fmt.format(r.total);
    return li;
  });
  boardList.replaceChildren(...next);
  boardEl.hidden = next.length === 0;

  // Last / Invert / Play.
  for (const li of next) {
    const prevTop = before.get(li.dataset.user);
    if (prevTop === undefined) {
      li.animate([{ opacity: 0, transform: 'translateX(-1rem)' }, { opacity: 1, transform: 'none' }], { duration: 320, easing: 'ease-out' });
      continue;
    }
    const dy = prevTop - li.getBoundingClientRect().top;
    if (Math.abs(dy) > 0.5) {
      li.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 420, easing: 'cubic-bezier(.2,.8,.2,1)' });
    }
  }
}

// ---------- 3. particles ----------
const particles = new Particles($('#particles'));

// ---------- 3b. pixel characters (one rAF loop, canvas only) ----------
let characters = null;
try {
  characters = new CharacterLayer($('#characters'));
} catch (err) {
  console.warn('[overlay] pixel characters unavailable', err); // the rest of the overlay keeps working
}
addEventListener('pagehide', () => characters?.destroy());

// ---------- 4. combo ----------
const comboEl = $('#combo');
const comboCountEl = comboEl.querySelector('.combo__count');

function showCombo(key, user, gift, comboCount) {
  clearTimeout(state.comboHideTimer);
  const changedKey = state.comboKey !== key;
  state.comboKey = key;
  comboEl.querySelector('.combo__gift').textContent = gift.name;
  comboEl.querySelector('.combo__user').textContent = user.name;
  comboEl.querySelector('.combo__n').textContent = String(comboCount);
  if (comboEl.hidden || changedKey || comboEl.classList.contains('is-out')) {
    comboEl.hidden = false;
    comboEl.classList.remove('is-out');
    void comboEl.offsetWidth;
    comboEl.classList.add('is-in');
  }
  comboCountEl.classList.remove('bump');
  void comboCountEl.offsetWidth;
  comboCountEl.classList.add('bump');
  // Safety: hide if the stream stops talking about this streak.
  state.comboHideTimer = setTimeout(hideCombo, 3000);
}

function hideCombo() {
  clearTimeout(state.comboHideTimer);
  state.comboKey = null;
  comboEl.classList.remove('is-in');
  comboEl.classList.add('is-out');
}
comboEl.addEventListener('animationend', (e) => {
  if (e.animationName === 'combo-out' && state.comboKey === null) comboEl.hidden = true;
});

// ---------- 5. ticker ----------
const tickerEl = $('#ticker');
const tickerList = tickerEl.querySelector('.ticker__list');
function addTicker(ev) {
  const li = document.createElement('li');
  li.className = 'ticker__item';
  const b = document.createElement('b');
  b.textContent = ev.user.name;
  li.append(b, document.createTextNode(ev.text));
  tickerList.append(li);
  while (tickerList.childElementCount > TICKER_MAX) tickerList.firstElementChild.remove();
  tickerEl.hidden = !(locked.ticker ?? state.config.ticker);
}

// ---------- event dispatch ----------
function onGift(ev) {
  const key = `${ev.user.id}|${ev.gift.id}`;
  if (ev.gift.comboCount > 1 || state.comboKey === key) {
    showCombo(key, ev.user, ev.gift, ev.gift.comboCount);
    clearTimeout(state.comboHideTimer);
    state.comboHideTimer = setTimeout(hideCombo, COMBO_LINGER_MS);
  }
  banners.push(ev);
  if (document.getElementsByTagName('*').length < MAX_DOM_NODES) particles.burst(ev.gift.diamondTotal);
  chime(ev.gift.diamondTotal);
}

const handlers = {
  hello(d) {
    applyConfig(d.config);
    renderLeaderboard(d.leaderboard ?? []);
    characters?.setLeaderboard(d.leaderboard ?? []);
    tickerList.replaceChildren();
    for (const c of d.recentComments ?? []) addTicker(c);
    applyConfig({});
  },
  config: applyConfig,
  leaderboard(rows) {
    renderLeaderboard(rows);
    characters?.setLeaderboard(rows);
  },
  combo(d) {
    if (d.comboCount >= 2) showCombo(d.key, d.user, d.gift, d.comboCount);
    characters?.onCombo(d);
  },
  event(ev) {
    if (ev.type === 'gift' && ev.gift) onGift(ev);
    else if (ev.type === 'comment' && ev.text) addTicker(ev);
    characters?.onEvent(ev);
  },
  clear() {
    characters?.clear();
    banners.clear();
    bannerEl.hidden = true;
    particles.clear();
    hideCombo();
    comboEl.hidden = true;
    tickerList.replaceChildren();
    tickerEl.hidden = true;
  },
  status() {},
};

// ---------- 6. waiting hint (until the first event; never with ?demo=1) ----------
const waitingEl = $('#waiting');
const waiting = { demo: isDemo(location.search), seenActivity: false };
function updateWaiting(msg) {
  if (isActivity(msg)) waiting.seenActivity = true;
  else if (waitingEl.hidden && msg.kind !== 'hello') return; // only 'hello' may reveal it
  const show = waitingHintVisible(waiting);
  if (show) {
    waitingEl.hidden = false;
    waitingEl.classList.remove('is-gone');
  } else if (!waitingEl.hidden) {
    waitingEl.classList.add('is-gone'); // CSS fades it out
  }
}
waitingEl.addEventListener('transitionend', () => {
  if (waitingEl.classList.contains('is-gone')) waitingEl.hidden = true;
});

function dispatch(msg) {
  try {
    updateWaiting(msg);
    const fn = handlers[msg?.kind];
    if (fn) fn(msg.data);
  } catch (err) {
    // A bad message must never take the overlay down.
    console.warn('[overlay] failed to render message', msg?.kind, err);
  }
}

// ---------- websocket with backoff ----------
let retry = 0;
function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => {
    retry = 0;
    $('#conn').hidden = true;
  };
  ws.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    dispatch(msg);
  };
  ws.onclose = () => {
    $('#conn').hidden = false;
    const delay = Math.min(10_000, 500 * 2 ** retry++);
    setTimeout(connect, delay);
  };
  ws.onerror = () => ws.close();
}

applyConfig({});
connect(); // the waiting hint is decided on 'hello', so a reload mid-stream never flashes it

// Debug/test hook (used by the screenshot script): expose read-only stats.
window.__overlay = {
  stats: () => ({
    nodes: document.getElementsByTagName('*').length,
    liveParticles: particles.live,
    bannerQueue: banners.size,
    bannerDropped: banners.dropped,
    leaderboard: [...boardList.children].map((li) => li.dataset.user),
    theme: document.documentElement.dataset.theme,
    waitingVisible: !waitingEl.hidden && !waitingEl.classList.contains('is-gone'),
    characters: characters?.stats() ?? null,
  }),
  benchCharacters: (n) => characters?.bench(n) ?? null,
};
