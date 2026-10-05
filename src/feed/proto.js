// Hand-written Protobuf decoder for Upstox Market Data Feed V3 (see MarketDataFeedV3.proto, copied from the
// official upstox-js-sdk). No dependencies, no code generation (Hermes-safe). Only the fields the app uses are
// decoded; unknown fields are skipped by wire type.
//
// proto3 omits default values (0 / empty) on the wire, so every decoder starts from explicit defaults:
//   Type.initial_feed = 0 and MarketStatus.PRE_OPEN_START = 0 are NOT transmitted.

export class ProtoError extends Error {}

const TYPE = ['initial_feed', 'live_feed', 'market_info'];
const MARKET_STATUS = ['PRE_OPEN_START', 'PRE_OPEN_END', 'NORMAL_OPEN', 'NORMAL_CLOSE', 'CLOSING_START', 'CLOSING_END'];
const REQUEST_MODE = ['ltpc', 'full_d5', 'option_greeks', 'full_d30'];
const TWO32 = 4294967296;

class Reader {
  constructor(buf, pos = 0, end = buf.length) {
    this.b = buf; this.p = pos; this.end = end;
    this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  eof() { return this.p >= this.end; }
  // Varint -> JS number. Exact up to 2^53 (epoch-ms timestamps and quantities are far below that).
  varint() {
    let lo = 0, hi = 0, shift = 0, byte;
    do {
      if (this.p >= this.end) throw new ProtoError('truncated varint');
      if (shift >= 70) throw new ProtoError('varint too long');
      byte = this.b[this.p++];
      const v = byte & 0x7f;
      if (shift < 28) lo |= v << shift;
      else if (shift === 28) { lo |= (v & 0x0f) << 28; hi = v >> 4; }
      else hi |= v << (shift - 32);
      shift += 7;
    } while (byte & 0x80);
    lo >>>= 0; hi >>>= 0;
    if (hi >= 0x80000000) return -((TWO32 - hi - (lo ? 1 : 0)) * TWO32 + (TWO32 - lo) % TWO32); // negative int64
    return hi * TWO32 + lo;
  }
  double() {
    if (this.p + 8 > this.end) throw new ProtoError('truncated double');
    const v = this.dv.getFloat64(this.p, true); this.p += 8; return v;
  }
  bytes() {
    const n = this.varint();
    if (n < 0 || this.p + n > this.end) throw new ProtoError('truncated length-delimited field');
    const s = this.p; this.p += n; return [s, s + n];
  }
  string() {
    const [s, e] = this.bytes(); let out = '';
    for (let i = s; i < e;) { // UTF-8 -> string without TextDecoder (not guaranteed on Hermes)
      const c = this.b[i++];
      if (c < 0x80) out += String.fromCharCode(c);
      else if (c < 0xe0) out += String.fromCharCode(((c & 0x1f) << 6) | (this.b[i++] & 0x3f));
      else if (c < 0xf0) { out += String.fromCharCode(((c & 0x0f) << 12) | ((this.b[i++] & 0x3f) << 6) | (this.b[i++] & 0x3f)); }
      else {
        const cp = (((c & 0x07) << 18) | ((this.b[i++] & 0x3f) << 12) | ((this.b[i++] & 0x3f) << 6) | (this.b[i++] & 0x3f)) - 0x10000;
        out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
      }
    }
    return out;
  }
  sub() { const [s, e] = this.bytes(); return new Reader(this.b, s, e); }
  skip(wire) {
    if (wire === 0) this.varint();
    else if (wire === 1) { if (this.p + 8 > this.end) throw new ProtoError('truncated fixed64'); this.p += 8; }
    else if (wire === 2) this.bytes();
    else if (wire === 5) { if (this.p + 4 > this.end) throw new ProtoError('truncated fixed32'); this.p += 4; }
    else throw new ProtoError('unsupported wire type ' + wire);
  }
}

// Iterate (field, wire) pairs of a message.
function each(r, fn) {
  while (!r.eof()) {
    const tag = r.varint();
    const field = Math.floor(tag / 8), wire = tag % 8;
    if (field === 0) throw new ProtoError('invalid field number 0');
    if (fn(field, wire) !== true) r.skip(wire);
  }
}

function ltpc(r) {
  const o = { ltp: 0, ltt: 0, ltq: 0, cp: 0 };
  each(r, (f, w) => {
    if (f === 1 && w === 1) { o.ltp = r.double(); return true; }
    if (f === 2 && w === 0) { o.ltt = r.varint(); return true; }
    if (f === 3 && w === 0) { o.ltq = r.varint(); return true; }
    if (f === 4 && w === 1) { o.cp = r.double(); return true; }
    return false; // iep (DoubleValue) etc. skipped
  });
  return o;
}

function ohlc(r) {
  const o = { interval: '', open: 0, high: 0, low: 0, close: 0, vol: 0, ts: 0 };
  each(r, (f, w) => {
    if (f === 1 && w === 2) { o.interval = r.string(); return true; }
    if (f >= 2 && f <= 5 && w === 1) { o[['open', 'high', 'low', 'close'][f - 2]] = r.double(); return true; }
    if (f === 6 && w === 0) { o.vol = r.varint(); return true; }
    if (f === 7 && w === 0) { o.ts = r.varint(); return true; }
    return false;
  });
  return o;
}

function marketOhlc(r) {
  const list = [];
  each(r, (f, w) => { if (f === 1 && w === 2) { list.push(ohlc(r.sub())); return true; } return false; });
  return list;
}

function greeks(r) {
  const o = { delta: 0, theta: 0, gamma: 0, vega: 0, rho: 0 };
  each(r, (f, w) => { if (f >= 1 && f <= 5 && w === 1) { o[['delta', 'theta', 'gamma', 'vega', 'rho'][f - 1]] = r.double(); return true; } return false; });
  return o;
}

function indexFullFeed(r) {
  const o = { ltpc: null, ohlc: [] };
  each(r, (f, w) => {
    if (f === 1 && w === 2) { o.ltpc = ltpc(r.sub()); return true; }
    if (f === 2 && w === 2) { o.ohlc = marketOhlc(r.sub()); return true; }
    return false;
  });
  return o;
}

function marketFullFeed(r) {
  const o = { ltpc: null, ohlc: [], greeks: null, atp: 0, vtt: 0, oi: 0, iv: 0 };
  each(r, (f, w) => {
    if (f === 1 && w === 2) { o.ltpc = ltpc(r.sub()); return true; }
    if (f === 3 && w === 2) { o.greeks = greeks(r.sub()); return true; }
    if (f === 4 && w === 2) { o.ohlc = marketOhlc(r.sub()); return true; }
    if (f === 5 && w === 1) { o.atp = r.double(); return true; }
    if (f === 6 && w === 0) { o.vtt = r.varint(); return true; }
    if (f === 7 && w === 1) { o.oi = r.double(); return true; }
    if (f === 8 && w === 1) { o.iv = r.double(); return true; }
    return false;
  });
  return o;
}

function firstLevelWithGreeks(r) {
  const o = { ltpc: null, greeks: null, vtt: 0, oi: 0, iv: 0 };
  each(r, (f, w) => {
    if (f === 1 && w === 2) { o.ltpc = ltpc(r.sub()); return true; }
    if (f === 3 && w === 2) { o.greeks = greeks(r.sub()); return true; }
    if (f === 4 && w === 0) { o.vtt = r.varint(); return true; }
    if (f === 5 && w === 1) { o.oi = r.double(); return true; }
    if (f === 6 && w === 1) { o.iv = r.double(); return true; }
    return false;
  });
  return o;
}

// Feed -> { kind, ltpc, ohlc, greeks, ... } with the ltpc lifted out of whichever branch of the oneof was sent.
function feed(r) {
  const o = { kind: 'none', ltpc: null, ohlc: [], greeks: null, vtt: 0, oi: 0, iv: 0, requestMode: 'ltpc' };
  each(r, (f, w) => {
    if (f === 1 && w === 2) { o.kind = 'ltpc'; o.ltpc = ltpc(r.sub()); return true; }
    if (f === 2 && w === 2) { // FullFeed { marketFF = 1 | indexFF = 2 }
      const ff = r.sub();
      each(ff, (f2, w2) => {
        if (f2 === 1 && w2 === 2) { o.kind = 'marketFF'; Object.assign(o, marketFullFeed(ff.sub())); return true; }
        if (f2 === 2 && w2 === 2) { o.kind = 'indexFF'; Object.assign(o, indexFullFeed(ff.sub())); return true; }
        return false;
      });
      return true;
    }
    if (f === 3 && w === 2) { o.kind = 'firstLevelWithGreeks'; Object.assign(o, firstLevelWithGreeks(r.sub())); return true; }
    if (f === 4 && w === 0) { o.requestMode = REQUEST_MODE[r.varint()] || 'ltpc'; return true; }
    return false;
  });
  return o;
}

function statusInfo(r) {
  const o = { status: '', updatedTime: 0 };
  each(r, (f, w) => {
    if (f === 1 && w === 2) { o.status = r.string(); return true; }
    if (f === 2 && w === 0) { o.updatedTime = r.varint(); return true; }
    return false;
  });
  return o;
}

// map<string, V> entry: key = field 1, value = field 2. A missing value means the proto3 default.
function mapEntry(r, readValue, defaultValue) {
  let key = '', val = defaultValue;
  each(r, (f, w) => {
    if (f === 1 && w === 2) { key = r.string(); return true; }
    if (f === 2) { val = readValue(r, w); return true; }
    return false;
  });
  return [key, val];
}

function marketInfo(r) {
  const o = { segmentStatus: {}, casMarketStatus: {}, preOpenSessionStatus: {} };
  each(r, (f, w) => {
    if (w !== 2) return false;
    if (f === 1) {
      const [k, v] = mapEntry(r.sub(), (rr) => rr.varint(), 0);
      if (k) o.segmentStatus[k] = MARKET_STATUS[v] || 'UNKNOWN';
      return true;
    }
    if (f === 2 || f === 3) {
      const [k, v] = mapEntry(r.sub(), (rr) => statusInfo(rr.sub()), { status: '', updatedTime: 0 });
      if (k) o[f === 2 ? 'casMarketStatus' : 'preOpenSessionStatus'][k] = v;
      return true;
    }
    return false;
  });
  return o;
}

// Decode a binary WebSocket frame (ArrayBuffer | Uint8Array) into a FeedResponse object.
export function decodeFeedResponse(data) {
  const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
  const r = new Reader(buf);
  const out = { type: 'initial_feed', feeds: {}, currentTs: 0, marketInfo: null };
  each(r, (f, w) => {
    if (f === 1 && w === 0) { out.type = TYPE[r.varint()] || 'unknown'; return true; }
    if (f === 2 && w === 2) {
      const [k, v] = mapEntry(r.sub(), (rr) => feed(rr.sub()), null);
      if (k && v) out.feeds[k] = v;
      return true;
    }
    if (f === 3 && w === 0) { out.currentTs = r.varint(); return true; }
    if (f === 4 && w === 2) { out.marketInfo = marketInfo(r.sub()); return true; }
    return false;
  });
  return out;
}

// Encode the JSON subscription request as the BINARY frame Upstox requires (text frames are rejected).
export function encodeRequest(obj) {
  const s = JSON.stringify(obj); const bytes = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) { c = 0x10000 + ((c - 0xd800) << 10) + (s.charCodeAt(++i) - 0xdc00); }
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return new Uint8Array(bytes);
}
