// Feed logger. Redacts anything that looks like a credential before it reaches the console.
const SECRET_KEYS = /(token|secret|password|passwd|otp|mpin|pin|authorization|api[_-]?key|code)/i;
const MAX_LOG = 200;
const buffer = [];

export function redact(v, depth = 0) {
  if (v === null || v === undefined) return v;
  if (typeof v === 'string') {
    return v
      .replace(/Bearer\s+[A-Za-z0-9._\-~+/=]+/gi, 'Bearer [REDACTED]')
      .replace(/([?&](?:code|token|access_token|req|requestId)=)[^&\s]+/gi, '$1[REDACTED]')
      .replace(/eyJ[A-Za-z0-9._\-]{20,}/g, '[REDACTED_JWT]');
  }
  if (typeof v !== 'object') return v;
  if (depth > 3) return '[...]';
  if (Array.isArray(v)) return v.map((x) => redact(x, depth + 1));
  const out = {};
  Object.keys(v).forEach((k) => { out[k] = SECRET_KEYS.test(k) ? '[REDACTED]' : redact(v[k], depth + 1); });
  return out;
}

export function flog(event, data) {
  const line = { t: Date.now(), event, data: data === undefined ? undefined : redact(data) };
  buffer.push(line);
  if (buffer.length > MAX_LOG) buffer.shift();
  if (typeof __DEV__ !== 'undefined' ? __DEV__ : process.env.FEED_LOG === '1') {
    // eslint-disable-next-line no-console
    console.log('[feed]', event, line.data === undefined ? '' : JSON.stringify(line.data));
  }
  return line;
}

export const recentLogs = () => buffer.slice();
export const clearLogs = () => { buffer.length = 0; };
