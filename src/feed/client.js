// Upstox Market Data Feed V3 WebSocket client.
//   authorize (REST, single-use wss URL) -> WebSocket (binary frames) -> binary "sub" request -> Protobuf frames
//   frames: market_info -> snapshot (initial_feed) -> live_feed ticks
// Lifecycle: CONNECTING -> CONNECTED -> SUBSCRIBED -> LIVE, with RECONNECTING / DISCONNECTED / ERROR.
// One socket at a time. Every socket gets a generation number; events from any older socket are ignored, so a
// late callback can never duplicate subscriptions, resurrect a dead socket or leak a handler.
import { decodeFeedResponse, encodeRequest, ProtoError } from './proto';
import { flog } from './logger';

export const CONN = {
  CONNECTING: 'CONNECTING', CONNECTED: 'CONNECTED', SUBSCRIBED: 'SUBSCRIBED', LIVE: 'LIVE',
  RECONNECTING: 'RECONNECTING', DISCONNECTED: 'DISCONNECTED', ERROR: 'ERROR',
};

const DEFAULTS = { baseMs: 1000, maxMs: 30000, jitter: 0.2, watchdogMs: 30000, watchdogCheckMs: 5000, mode: 'full' };

export class FeedClient {
  constructor(o) {
    this.authorize = o.authorize;                       // async () => 'wss://...' ; throws {kind:'AUTH'} when the token is rejected
    this.WS = o.WebSocketImpl || (typeof WebSocket !== 'undefined' ? WebSocket : null);
    this.keys = o.keys;                                 // instrument keys to subscribe
    this.primaryKey = o.primaryKey || o.keys[0];        // LIVE is declared on the first valid tick of this key
    this.onState = o.onState || (() => {});
    this.onFeed = o.onFeed || (() => {});
    this.onAuthError = o.onAuthError || (() => {});
    this.now = o.now || Date.now;
    this.st = o.setTimeoutFn || setTimeout;
    this.ct = o.clearTimeoutFn || clearTimeout;
    this.rand = o.random || Math.random;
    this.log = o.log || flog;
    this.isMarketOpen = o.isMarketOpen || (() => false);
    this.cfg = { ...DEFAULTS, ...(o.config || {}) };

    this.state = CONN.DISCONNECTED; this.detail = '';
    this.want = false; this.gen = 0; this.ws = null;
    this.attempt = 0; this.retryTimer = null; this.watchTimer = null;
    this.lastMessageAt = 0; this.sawData = false; this.subscribeCount = 0; this.opening = false;
  }

  _set(state, detail = '') {
    if (this.state === state && this.detail === detail) return;
    this.state = state; this.detail = detail;
    this.onState({ conn: state, connMsg: detail, attempt: this.attempt, at: this.now() });
  }

  start() {
    if (this.want) return;                               // already running: no second socket, no second subscription
    if (!this.WS) { this._set(CONN.ERROR, 'WebSocket is not available on this device'); return; }
    this.want = true; this.attempt = 0;
    this._open();
  }

  // Full teardown: socket closed, handlers detached, timers cleared.
  stop() {
    this.want = false;
    this._teardown();
    this._set(CONN.DISCONNECTED, 'Feed stopped');
    this.log('Market feed stopped');
  }

  _teardown() {
    this.gen += 1;                                       // invalidates every callback of the old socket
    this._clearTimers();
    const ws = this.ws; this.ws = null; this.opening = false;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try { ws.close(); } catch (e) { /* already closed */ }
    }
  }

  _clearTimers() {
    if (this.retryTimer) { this.ct(this.retryTimer); this.retryTimer = null; }
    if (this.watchTimer) { this.ct(this.watchTimer); this.watchTimer = null; }
  }

  async _open() {
    if (!this.want || this.opening || this.ws) return;
    this.opening = true;
    const gen = ++this.gen;
    this._set(this.attempt > 0 ? CONN.RECONNECTING : CONN.CONNECTING, this.attempt > 0 ? `Reconnecting (attempt ${this.attempt})...` : 'Connecting to Upstox live feed...');
    let url;
    try {
      url = await this.authorize();
    } catch (e) {
      if (gen !== this.gen) return;
      this.opening = false;
      if (e && e.kind === 'AUTH') {
        this.want = false; this._set(CONN.ERROR, (e && e.message) || 'Session expired. Login again.');
        this.log('Feed authorization rejected (session expired)');
        this.onAuthError(e); return;
      }
      this.log('Feed authorize failed', { kind: e && e.kind, message: e && e.message });
      this._scheduleReconnect((e && e.message) || 'authorize failed'); return;
    }
    if (gen !== this.gen || !this.want) { this.opening = false; return; }
    let ws;
    try {
      ws = new this.WS(url);
      ws.binaryType = 'arraybuffer';
    } catch (e) {
      this.opening = false;
      this.log('WebSocket construction failed', { message: e && e.message });
      this._scheduleReconnect('socket error'); return;
    }
    this.ws = ws; this.opening = false; this.sawData = false; this.lastMessageAt = this.now();
    ws.onopen = () => { if (gen === this.gen) this._onOpen(); };
    ws.onmessage = (ev) => { if (gen === this.gen) this._onMessage(ev); };
    ws.onerror = (ev) => { if (gen === this.gen) this._onError(ev); };
    ws.onclose = (ev) => { if (gen === this.gen) this._onClose(ev); };
  }

  _onOpen() {
    this._set(CONN.CONNECTED, 'Connected, subscribing...');
    this.log('Market feed connected');
    this.lastMessageAt = this.now();
    const req = { guid: this._guid(), method: 'sub', data: { mode: this.cfg.mode, instrumentKeys: this.keys } };
    try {
      this.ws.send(encodeRequest(req));                  // BINARY frame, as required by Upstox V3
      this.subscribeCount += 1;
      this._set(CONN.SUBSCRIBED, 'Subscribed, waiting for data...');
      this.log('Subscription request sent', { mode: this.cfg.mode, keys: this.keys });
    } catch (e) {
      this.log('Subscription send failed', { message: e && e.message });
      this._lost('subscribe failed'); return;
    }
    this._armWatchdog();
  }

  _onMessage(ev) {
    this.lastMessageAt = this.now();
    const d = ev && ev.data;
    if (typeof d === 'string') { this.log('Unexpected text frame ignored', { length: d.length }); return; }
    let resp;
    try { resp = decodeFeedResponse(d); } catch (e) {
      this.log('Protobuf decode failed', { error: e instanceof ProtoError ? e.message : String(e && e.message) });
      this.onFeed(null, this.lastMessageAt, e); return;
    }
    if (resp.type === 'market_info') this.log('Market info received', { segments: resp.marketInfo ? Object.keys(resp.marketInfo.segmentStatus).length : 0 });
    const keys = Object.keys(resp.feeds || {});
    if (keys.length && !this.sawData) { this.sawData = true; this.log('Subscription confirmed (first data received)', { keys: keys.length }); }
    this.onFeed(resp, this.lastMessageAt);
    const p = resp.feeds && resp.feeds[this.primaryKey];
    if (p && p.ltpc && p.ltpc.ltp > 0 && this.state !== CONN.LIVE) {
      this.attempt = 0;                                  // a healthy connection resets the backoff
      this._set(CONN.LIVE, '');
      this.log('NIFTY tick received (feed LIVE)');
    }
  }

  _onError(ev) {
    this.log('Market feed socket error', { message: ev && (ev.message || ev.error && ev.error.message) });
    this._lost('socket error');
  }

  _onClose(ev) {
    this.log('Market feed closed', { code: ev && ev.code, reason: ev && ev.reason });
    this._lost('connection closed');
  }

  // Connection lost: dispose the socket completely, then reconnect with backoff (if still wanted).
  _lost(why) {
    if (!this.ws && !this.opening) return;
    this._teardown();
    if (!this.want) { this._set(CONN.DISCONNECTED, why); return; }
    this._scheduleReconnect(why);
  }

  _scheduleReconnect(why) {
    if (!this.want) return;
    this._clearTimers();
    this.attempt += 1;
    const raw = Math.min(this.cfg.maxMs, this.cfg.baseMs * Math.pow(2, this.attempt - 1));
    const delay = Math.round(raw * (1 + (this.rand() * 2 - 1) * this.cfg.jitter));
    this._set(CONN.RECONNECTING, `Live data temporarily unavailable (${why}). Retrying in ${Math.max(1, Math.round(delay / 1000))}s.`);
    this.log('Reconnect attempt scheduled', { attempt: this.attempt, delayMs: delay, why });
    this.retryTimer = this.st(() => { this.retryTimer = null; this._open(); }, delay);
  }

  // A half-open socket delivers nothing and never errors. While the market is open the feed must talk.
  _armWatchdog() {
    if (this.watchTimer) this.ct(this.watchTimer);
    const gen = this.gen;
    this.watchTimer = this.st(() => {
      if (gen !== this.gen || !this.ws) return;
      if (this.isMarketOpen() && this.now() - this.lastMessageAt > this.cfg.watchdogMs) {
        this.log('Data became stale: feed silent while market open', { silentMs: this.now() - this.lastMessageAt });
        this._lost('feed silent'); return;
      }
      this._armWatchdog();
    }, this.cfg.watchdogCheckMs);
  }

  _guid() {
    let s = ''; const c = 'abcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 20; i++) s += c[Math.floor(this.rand() * c.length)];
    return s;
  }
}
