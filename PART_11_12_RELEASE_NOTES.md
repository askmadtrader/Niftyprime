NiftyView — Parts 11 + 12 UI/Production pass

Applied to the supplied Part 10B integration source.

UI changes:
- Dashboard order now starts with market status/NIFTY/VIX context, then signal, analytics, option chain, OI/PCR/IV, chart and global context.
- Removed duplicate secondary dashboard cards to reduce vertical scrolling.
- Chart can render inside the dashboard as well as its dedicated Chart tab.
- Chart plot now has a visible card/background boundary instead of a black-looking empty area.
- Existing real-candle pan, pinch zoom, Older/Newer and Latest controls are preserved.
- Existing freshness/session/error labels are preserved and surfaced in the relevant sections.
- ATM and selected expiry remain explicitly highlighted in the option chain.
- Alerts explicitly state that they never place trades.
- Settings explicitly identifies connection/data status and account/security area.
- No API secrets, tokens, passwords, OTPs or MPINs were added.

Production checks:
- Signal/chart/analytics focused tests: 169 passed, 0 failed.
- Full test command could not be completed in this build environment because the npm dependency installation was interrupted/incomplete (protobufjs/ws were unavailable). No test failure was caused by the UI changes.
- Android release build was not claimed here because the Android/Expo build toolchain was not successfully installed in this environment.

Important:
- Parts 1–10 logic was not intentionally rewritten.
- No automatic trading/order execution was added.
- Real-data/freshness behavior remains the responsibility of the existing data layer.

---
Follow-up fixes
- Added price alerts (NIFTY above/below) and VIX alerts (above/below): src/levelAlerts.js, Alerts screen section "Price & VIX alerts".
  One-shot, fire only on a cross between two LIVE/FRESH readings; stale/missing/previous-session values never trigger. No trading.
- Settings: added "Alert settings" and "Debug (no secrets shown)" cards.
- Tests: 367 passed, 0 failed (npm test). Android JS bundle (Hermes) compiles via `expo export`.
- NOT DONE: signed release APK. No Android SDK in the authoring environment; build with the GitHub workflow (.github/workflows/build.yml).
  Device checks (install, launch, chart, no black chart, live connection) are still pending.

Fixes after first phone test
- Global context: each row now shows the change in points AND percent (e.g. +0.52 (+0.49%)).
- Chart tab: now scrolls (was a fixed view, so controls below the chart were unreachable). Horizontal drag uses the gesture's own dx and pauses page scrolling while you drag.
- Option chain: large numbers shrink to fit instead of "14.36...".
- Header: duplicate MARKET CLOSED pill removed; detail lines collapse (tap "details").

NIFTY Futures
- Dashboard > Global context > India: "NIFTY Futures" row (nearest unexpired NIFTY index future, looked up daily via Upstox
  /v2/instruments/search, streamed on the same Market Data Feed). Shows price, change (pts, %), premium vs NIFTY, status and exchange time.
- GIFT NIFTY stays DATA UNAVAILABLE: it trades on NSE IX and Upstox offers no feed for it.
- UNVERIFIED against the live API (written from Upstox docs; not testable offline). If the row stays "DATA UNAVAILABLE", check Settings > Debug.

Speed + US futures
- US FUTURES block (S&P 500, Nasdaq 100, Dow futures via Yahoo, unofficial, may lag a little).
- Option chain: ATM +/- strikes are streamed on the live feed; ltp / OI / volume update tick-by-tick between REST refreshes (IV, Greeks, bid/ask still REST).
- Candles refresh every cycle (was every 2nd), chart every 5 s (was 15 s), global every 30 s (was 60 s).
- GIFT NIFTY: still unavailable (NSE IX, no licensed free feed). Not scraped/guessed.
- Live option ticks and futures are written from the Upstox docs: UNVERIFIED against the live feed until tested in market hours.

Sectioned dashboard
- Dashboard is now a list of tiles (Signal, NIFTY levels & momentum, Option chain, Open interest, PCR/IV/Greeks, Chart, Futures/GIFT/global).
  Each tile shows its own status badge, one-line summary, "as of" time and a refresh button. Tap a tile to open it; Back / Android back returns.
- GIFT NIFTY: manual entry (MANUAL label, entry time, STALE after 30 min, gap vs NIFTY). Context only: the signal engine does not use it.
