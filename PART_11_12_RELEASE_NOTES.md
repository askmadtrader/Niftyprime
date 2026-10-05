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
