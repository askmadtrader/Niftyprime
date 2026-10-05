// Reference encoder: protobufjs + the OFFICIAL Upstox proto (copied from upstox-js-sdk). The app's own decoder is
// then checked against bytes produced by an independent implementation.
import protobuf from 'protobufjs';

const root = protobuf.loadSync(new URL('../src/feed/MarketDataFeedV3.proto', import.meta.url).pathname);
const FeedResponse = root.lookupType('com.upstox.marketdatafeederv3udapi.rpc.proto.FeedResponse');

export function encodeResp(obj) {
  // fromObject accepts enum names ('market_info') and throws on unknown fields/types; verify() would demand numbers.
  return FeedResponse.encode(FeedResponse.fromObject(obj)).finish();
}
export const toArrayBuffer = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);

// IST wall clock -> epoch ms
export const ist = (y, mo, d, h = 0, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h, mi, s) - 5.5 * 3600 * 1000;

export const NIFTY = 'NSE_INDEX|Nifty 50';
export const VIX = 'NSE_INDEX|India VIX';

export function marketInfoFrame(seg, ts = 1700000000000, extra = {}) {
  return encodeResp({ type: 'market_info', currentTs: ts, marketInfo: { segmentStatus: seg, ...extra } });
}
export function indexTick(key, ltp, ltt, cp, ts, day) {
  return encodeResp({
    type: 'live_feed', currentTs: ts,
    feeds: { [key]: { fullFeed: { indexFF: { ltpc: { ltp, ltt, ltq: 0, cp }, marketOHLC: { ohlc: day ? [{ interval: '1d', open: day.o, high: day.h, low: day.l, close: ltp, ts: day.ts }] : [] } } }, requestMode: 'full_d5' } },
  });
}
export function ltpcTick(key, ltp, ltt, cp, ts) {
  return encodeResp({ type: 'live_feed', currentTs: ts, feeds: { [key]: { ltpc: { ltp, ltt, ltq: 75, cp } } } });
}
