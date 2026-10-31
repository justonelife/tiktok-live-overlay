// Real-mode adapter around tiktok-live-connector (unofficial, AGPL-3.0).
// Maps library events to our raw event format and feeds them to `emit`.
// Every failure is caught and surfaced as status - the server never crashes.

export const USERNAME_RE = /^@?[A-Za-z0-9._]{2,24}$/;

const firstUrl = (...lists) => {
  for (const l of lists) if (Array.isArray(l) && typeof l[0] === 'string') return l[0];
  return '';
};

/** Map a tiktok-live-connector user object to our raw user. */
export function mapUser(u = {}) {
  return {
    id: String(u.userId ?? u.uniqueId ?? 'unknown'),
    name: u.nickname || u.uniqueId || 'unknown',
    avatarUrl: firstUrl(u.profilePicture?.url, u.profilePicture?.urls, u.avatarThumb?.urlList, u.avatarThumb?.url),
  };
}

const msgIdOf = (d) => {
  const id = d?.common?.msgId ?? d?.msgId;
  return id === undefined || id === null ? undefined : String(id);
};

/** Map a WebcastGiftMessage to our raw gift event. */
export function mapGift(d) {
  const det = d.giftDetails ?? {};
  const ext = d.extendedGiftInfo ?? {};
  return {
    type: 'gift',
    msgId: msgIdOf(d),
    user: mapUser(d.user),
    gift: {
      id: String(d.giftId ?? det.id ?? ext.id ?? '0'),
      name: det.giftName || ext.name || '',
      diamond: Number(det.diamondCount ?? ext.diamond_count ?? 0) | 0,
      repeatCount: Math.max(1, Number(d.repeatCount) | 0),
      repeatEnd: Boolean(d.repeatEnd),
      streakable: (det.giftType ?? ext.type) === 1,
    },
  };
}

export class TikTokSource {
  constructor({ emit, logger = console, loadLib = () => import('tiktok-live-connector') }) {
    this.emit = emit;
    this.logger = logger;
    this.loadLib = loadLib;
    this.conn = null;
    this.status = { state: 'idle', username: null, roomId: null, error: null, since: Date.now() };
  }

  #set(patch) {
    this.status = { ...this.status, ...patch, since: Date.now() };
    this.onStatus?.(this.status);
  }

  async connect(username) {
    if (!USERNAME_RE.test(username ?? '')) throw new TypeError('invalid TikTok username');
    const uniqueId = username.replace(/^@/, '');
    await this.disconnect();
    this.#set({ state: 'connecting', username: uniqueId, roomId: null, error: null });
    let lib;
    try {
      lib = await this.loadLib();
    } catch (err) {
      this.#set({ state: 'error', error: `tiktok-live-connector failed to load: ${err.message}` });
      return this.status;
    }
    const { TikTokLiveConnection, WebcastEvent, ControlEvent } = lib;
    const conn = new TikTokLiveConnection(uniqueId, { enableExtendedGiftInfo: true });
    this.conn = conn;
    const safe = (name, fn) => (data) => {
      try {
        const raw = fn(data);
        if (raw) this.emit(raw);
      } catch (err) {
        this.logger.warn(`[tiktok] failed to map ${name} event: ${err.message}`);
      }
    };
    conn.on(WebcastEvent.GIFT, safe('gift', mapGift));
    conn.on(WebcastEvent.CHAT, safe('chat', (d) => ({ type: 'comment', msgId: msgIdOf(d), user: mapUser(d.user), text: d.comment })));
    conn.on(WebcastEvent.LIKE, safe('like', (d) => ({ type: 'like', user: mapUser(d.user) })));
    conn.on(WebcastEvent.MEMBER, safe('member', (d) => ({ type: 'join', user: mapUser(d.user) })));
    conn.on(WebcastEvent.FOLLOW, safe('follow', (d) => ({ type: 'follow', user: mapUser(d.user) })));
    conn.on(WebcastEvent.SHARE, safe('share', (d) => ({ type: 'share', user: mapUser(d.user) })));
    conn.on(ControlEvent.ERROR, (err) => {
      const message = err?.info || err?.message || String(err);
      this.logger.warn(`[tiktok] error: ${message}`);
      this.#set({ error: message });
    });
    conn.on(ControlEvent.DISCONNECTED, () => {
      if (this.conn === conn) this.#set({ state: 'disconnected' });
    });
    conn.on(WebcastEvent.STREAM_END, () => {
      if (this.conn === conn) this.#set({ state: 'ended', error: 'The LIVE stream ended' });
    });

    try {
      const state = await conn.connect();
      if (this.conn !== conn) return this.status; // superseded
      this.#set({ state: 'connected', roomId: state?.roomId ?? null, error: null });
    } catch (err) {
      const message = describeError(err);
      this.logger.warn(`[tiktok] connect failed for @${uniqueId}: ${message}`);
      if (this.conn === conn) {
        this.conn = null;
        this.#set({ state: 'error', error: message });
      }
    }
    return this.status;
  }

  async disconnect() {
    const conn = this.conn;
    this.conn = null;
    if (!conn) return;
    try {
      await conn.disconnect();
    } catch (err) {
      this.logger.warn(`[tiktok] disconnect error: ${err.message}`);
    }
    this.#set({ state: 'idle', roomId: null });
  }
}

function describeError(err) {
  const name = err?.constructor?.name ?? 'Error';
  const msg = err?.message || String(err);
  if (name === 'UserOfflineError') return 'User is not LIVE right now.';
  if (name === 'InvalidUniqueIdError') return 'That TikTok username does not exist.';
  if (/room id/i.test(msg)) {
    return `Could not find a LIVE room (user offline, wrong username, or TikTok blocked the lookup). Details: ${msg}`.slice(0, 300);
  }
  if (/rate.?limit/i.test(name + msg)) return `Signing service rate-limited the request: ${msg}`;
  return `${name}: ${msg}`.slice(0, 300);
}
