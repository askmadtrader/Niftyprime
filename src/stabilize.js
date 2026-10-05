// Signal stabiliser (v17). Pure functions, analysis only: never places or prepares an order.
// 1. A CALL / PUT from the engine is SHOWN only after it has held continuously for confirmMs. Until then the card shows WAIT
//    ("CALL forming, confirming ...") so a one-tick flicker around an OI wall cannot raise an alert.
// 2. HIGH confidence needs highMs of continuous agreement; before that it is capped at MEDIUM.
// 3. If the recommended contract loses more than thetaCapPct of its premium per day, confidence is capped at MEDIUM and a note is added.
export const STAB = { confirmMs: 90000, highMs: 180000, thetaCapPct: 25, thetaWarnPct: 40 };

export const initialStab = () => ({ cand: null, since: 0 });

const rank = { LOW: 0, MEDIUM: 1, HIGH: 2 };
const capConf = (c, max) => (rank[c] > rank[max] ? max : c);

function withConf(a, conf, extraNote) {
  if (conf === a.confidence && !extraNote) return a;
  return { ...a, confidence: conf, ui: a.ui ? { ...a.ui, confidence: conf } : a.ui, notes: extraNote ? [...(a.notes || []), extraNote] : a.notes };
}

// st: previous state, a: merged analysis (signalBridge.mergeSignalIntoAnalysis), now: ms. Returns { st, a }.
export function stabilize(st, a, now, cfg = STAB) {
  const prev = st || initialStab();
  if (!a || !a.live || (a.signal !== 'CALL' && a.signal !== 'PUT') || (a.ui && a.ui.failSafe)) return { st: initialStab(), a };
  const raw = a.signal;
  const next = prev.cand === raw ? prev : { cand: raw, since: now };
  const held = now - next.since;
  if (held < cfg.confirmMs) {
    const left = Math.ceil((cfg.confirmMs - held) / 1000);
    const why = `${raw} forming: confirming, ${left}s left. A signal must hold ${Math.round(cfg.confirmMs / 1000)}s before it is shown.`;
    const ui = a.ui ? { ...a.ui, signal: 'WAIT', blockers: [why, ...(a.ui.blockers || [])] } : a.ui;
    return { st: next, a: { ...a, signal: 'WAIT', pending: raw, recommended: null, waitReason: why, notes: [], ui } };
  }
  let out = a;
  if (held < cfg.highMs) out = withConf(out, capConf(out.confidence, 'MEDIUM'));
  const rec = out.recommended;
  if (rec && rec.ltp > 0 && typeof rec.theta === 'number') {
    const pct = (Math.abs(rec.theta) / rec.ltp) * 100;
    if (pct > cfg.thetaCapPct) {
      const note = pct > cfg.thetaWarnPct
        ? `Theta is ${pct.toFixed(0)}% of this option's premium per day (expiry is very near). Confidence capped at MEDIUM.`
        : `Theta is ${pct.toFixed(0)}% of premium per day. Confidence capped at MEDIUM.`;
      out = withConf(out, capConf(out.confidence, 'MEDIUM'), note);
    }
  }
  return { st: next, a: out };
}
