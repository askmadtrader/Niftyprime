import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFeedResponse, encodeRequest, ProtoError } from '../src/feed/proto.js';
import { encodeResp, marketInfoFrame, indexTick, ltpcTick, NIFTY, VIX } from './helpers.mjs';

test('market_info: enum default 0 (PRE_OPEN_START) is omitted on the wire and still decodes', () => {
  const r = decodeFeedResponse(marketInfoFrame({ NSE_INDEX: 'PRE_OPEN_START', NSE_FO: 'NORMAL_OPEN', NSE_EQ: 'NORMAL_CLOSE', MCX_FO: 'CLOSING_START', BSE_EQ: 'CLOSING_END', NSE_COM: 'PRE_OPEN_END' }));
  assert.equal(r.type, 'market_info');
  assert.deepEqual(r.marketInfo.segmentStatus, { NSE_INDEX: 'PRE_OPEN_START', NSE_FO: 'NORMAL_OPEN', NSE_EQ: 'NORMAL_CLOSE', MCX_FO: 'CLOSING_START', BSE_EQ: 'CLOSING_END', NSE_COM: 'PRE_OPEN_END' });
  assert.equal(r.currentTs, 1700000000000);
});

test('market_info: CAS and pre-open session maps', () => {
  const f = marketInfoFrame({ NSE_EQ: 'NORMAL_CLOSE' }, 1700000000000, {
    casMarketStatus: { NSE_EQ: { status: 'CAS_LM_START', updatedTime: 1700000000123 } },
    preOpenSessionStatus: { NSE_EQ: { status: 'PRE_OPEN_END', updatedTime: 1699999000000 } },
  });
  const r = decodeFeedResponse(f);
  assert.deepEqual(r.marketInfo.casMarketStatus.NSE_EQ, { status: 'CAS_LM_START', updatedTime: 1700000000123 });
  assert.deepEqual(r.marketInfo.preOpenSessionStatus.NSE_EQ, { status: 'PRE_OPEN_END', updatedTime: 1699999000000 });
});

test('initial_feed (type 0, omitted on wire) with LTPC only', () => {
  const buf = encodeResp({ type: 'initial_feed', currentTs: 1740729566039, feeds: { 'NSE_FO|45450': { ltpc: { ltp: 219.3, ltt: 1740729552723, ltq: 75, cp: 494.05 } } } });
  const r = decodeFeedResponse(buf);
  assert.equal(r.type, 'initial_feed');
  const f = r.feeds['NSE_FO|45450'];
  assert.equal(f.kind, 'ltpc');
  assert.deepEqual(f.ltpc, { ltp: 219.3, ltt: 1740729552723, ltq: 75, cp: 494.05 });
});

test('index full feed: ltpc + 1d / I1 OHLC; int64 ms timestamps exact', () => {
  const buf = encodeResp({ type: 'live_feed', currentTs: 1790000000999, feeds: { [NIFTY]: { fullFeed: { indexFF: {
    ltpc: { ltp: 22421.95, ltt: 1790000000123, ltq: 0, cp: 22300.5 },
    marketOHLC: { ohlc: [{ interval: '1d', open: 22350.1, high: 22460.2, low: 22310.3, close: 22421.95, vol: 0, ts: 1789948200000 }, { interval: 'I1', open: 22420, high: 22425, low: 22418, close: 22421.95, vol: 0, ts: 1790000000000 }] },
  } }, requestMode: 'full_d5' } } });
  const f = decodeFeedResponse(buf).feeds[NIFTY];
  assert.equal(f.kind, 'indexFF');
  assert.equal(f.ltpc.ltt, 1790000000123);
  assert.equal(f.ltpc.cp, 22300.5);
  assert.equal(f.ohlc.length, 2);
  assert.equal(f.ohlc[0].interval, '1d');
  assert.equal(f.ohlc[0].high, 22460.2);
  assert.equal(f.ohlc[0].ts, 1789948200000);
  assert.equal(f.requestMode, 'full_d5');
});

test('market full feed and firstLevelWithGreeks branches expose ltpc + greeks', () => {
  const a = decodeFeedResponse(encodeResp({ type: 'live_feed', currentTs: 1, feeds: { x: { fullFeed: { marketFF: { ltpc: { ltp: 181.95, ltt: 1747984841612, ltq: 75, cp: 73.85 }, optionGreeks: { delta: 0.4519, theta: -17.6157, gamma: 0.0007, vega: 12.7741, rho: 1.8554 }, atp: 139.42, vtt: 119687250, oi: 8326800, iv: 0.1685 } }, requestMode: 'full_d30' } } })).feeds.x;
  assert.equal(a.kind, 'marketFF'); assert.equal(a.ltpc.ltp, 181.95); assert.equal(a.greeks.delta, 0.4519); assert.equal(a.oi, 8326800); assert.equal(a.vtt, 119687250); assert.equal(a.requestMode, 'full_d30');
  const b = decodeFeedResponse(encodeResp({ type: 'live_feed', currentTs: 1, feeds: { y: { firstLevelWithGreeks: { ltpc: { ltp: 225.7, ltt: 1740729368660, ltq: 75, cp: 494.05 }, optionGreeks: { delta: 0.5078 }, vtt: 919725, oi: 256800, iv: 0.1334 }, requestMode: 'option_greeks' } } })).feeds.y;
  assert.equal(b.kind, 'firstLevelWithGreeks'); assert.equal(b.ltpc.ltt, 1740729368660); assert.equal(b.greeks.delta, 0.5078); assert.equal(b.requestMode, 'option_greeks');
});

test('multiple instruments in one frame; unknown trailing fields are skipped', () => {
  const buf = encodeResp({ type: 'live_feed', currentTs: 5, feeds: {
    [NIFTY]: { ltpc: { ltp: 100.5, ltt: 1790000000000, cp: 99 } }, [VIX]: { ltpc: { ltp: 13.25, ltt: 1790000000500, cp: 13.5 } },
  } });
  const r = decodeFeedResponse(buf);
  assert.deepEqual(Object.keys(r.feeds).sort(), [NIFTY, VIX].sort());
  // append an unknown varint field (#15) and an unknown length-delimited field (#16); must be ignored
  const extra = new Uint8Array([...buf, 0x78, 0x07, 0x82, 0x01, 0x02, 0xaa, 0xbb]);
  assert.deepEqual(decodeFeedResponse(extra).feeds[VIX].ltpc.ltp, 13.25);
});

test('truncated / corrupt frames raise ProtoError (never hang, never return garbage prices)', () => {
  const buf = indexTick(NIFTY, 22421.95, 1790000000123, 22300.5, 1790000000999);
  for (const n of [1, 3, 10, buf.length - 1]) {
    assert.throws(() => decodeFeedResponse(buf.slice(0, n)), (e) => e instanceof ProtoError, `cut at ${n}`);
  }
  assert.throws(() => decodeFeedResponse(new Uint8Array([0x0a, 0xff, 0xff, 0xff, 0xff, 0x0f])), ProtoError);
  assert.throws(() => decodeFeedResponse(new Uint8Array([0x00])), ProtoError); // field number 0
});

test('empty frame decodes to defaults', () => {
  const r = decodeFeedResponse(new Uint8Array(0));
  assert.equal(r.type, 'initial_feed'); assert.deepEqual(r.feeds, {}); assert.equal(r.marketInfo, null);
});

test('decoder accepts ArrayBuffer (what React Native / ws deliver)', () => {
  const u8 = ltpcTick(NIFTY, 1.5, 1790000000000, 1.25, 1790000000100);
  const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  assert.equal(decodeFeedResponse(ab).feeds[NIFTY].ltpc.ltp, 1.5);
});

test('encodeRequest produces the exact UTF-8 bytes of the JSON (binary subscription frame)', () => {
  const req = { guid: 'abc123', method: 'sub', data: { mode: 'full', instrumentKeys: [NIFTY, VIX, 'NSE_INDEX|Nifty Bank ₹é'] } };
  assert.deepEqual(Buffer.from(encodeRequest(req)), Buffer.from(JSON.stringify(req), 'utf8'));
});
