NiftyView - NIFTY options analysis terminal (analysis only, never places orders)

BUILD
1. Upload all files (including the hidden .github folder) to your private GitHub repo, branch main.
2. The push starts "Build APK" automatically (or Actions > Build APK > Run workflow).
3. After ~10-15 min download NiftyView.apk from Releases and install it (arm64 phones).

DAILY USE
- Open app > "Login to Upstox" > log in > tap "Open NiftyView" on the confirmation page.
- Upstox sessions expire daily (~03:30 IST), so log in once each trading day.

SECURITY
- Upstox API key/secret live only as secrets on your Cloudflare Worker (niftyview-auth).
- The app stores only the daily session token in Android secure storage.
- Nothing secret is in this source code. The APK is signed with the standard Expo debug key
  (fine for personal installs; create your own upload key before publishing on Google Play).

DATA SOURCES
- Upstox Market Data Feed V3 (WebSocket + Protobuf): NIFTY 50, India VIX and market status (market_info). Live ticks only;
  nothing is cached across launches and no value is ever hardcoded or simulated.
- Upstox REST: option chain (OI, IV, Greeks), intraday candles (polled every 5-30 s) - reworked in later parts.
- Yahoo Finance (unofficial): DXY, US 10Y, crude, gold, USD/INR, US and Asian indices. GIFT NIFTY has no
  reliable free feed and is shown as DATA UNAVAILABLE.

MARKET-DATA FOUNDATION (src/feed/)
- proto.js        Protobuf decoder for MarketDataFeedV3.proto (official proto kept next to it)
- client.js       WebSocket lifecycle: CONNECTING > CONNECTED > SUBSCRIBED > LIVE, RECONNECTING, DISCONNECTED, ERROR
- marketStatus.js market_info -> PRE_OPEN / NORMAL_OPEN / CLOSED / CLOSING_AUCTION / UNKNOWN (NSE_INDEX, NSE_FO, NSE_EQ)
- session.js      current vs previous session (IST trading date, exchange-aligned clock)
- freshness.js    LIVE / FRESH / STALE / DISCONNECTED / UNAVAILABLE per source
- gate.js         data-quality gate: returns WAIT + reason unless everything is live and current
TESTS: npm test   (Node 22, no device needed; also runs in the GitHub build before the APK)

DATA FRESHNESS + SESSION CORRECTNESS (PART 2)
- Every value carries marketTs (exchange time), receivedAt (device time) and tradingDate (IST date of marketTs).
- Status per source: LIVE | FRESH | STALE | DISCONNECTED | UNAVAILABLE (NIFTY, VIX, candles, option chain, global).
  A future or invalid timestamp is STALE; a previous-session value is STALE while the market is open, FRESH-but-labelled
  PREVIOUS SESSION when it is closed. Only LIVE/FRESH values of the CURRENT session feed live analytics (usableForLive).
- Day open/high/low come from the feed's 1d candle only if it is dated the same IST trading date as the tick.
- Option chain: Upstox returns no exchange timestamp, so none is invented (shown as "no exchange timestamp"); freshness
  comes from receive time and the market phase when the request was made.
- UI shows "Data as of HH:mm:ss IST" (date appended when not today), session badge, trading date and received time.
- India VIX is an optional factor: stale/missing/previous-session VIX is dropped and shown as a warning, not a blocker.
- src/feed/stamp.js (text helpers), freshness.js (all statuses), tests/freshness.test.mjs.

DYNAMIC EXPIRIES + OPTION CONTRACTS (PART 3)
- src/contracts.js  Contract model + expiry logic (pure, tested). Source: Upstox GET /v2/option/contract?instrument_key=NSE_INDEX|Nifty 50
                    Contract = { instrumentKey, tradingSymbol, expiry, strike, type (CE|PE), lotSize, tickSize, weekly, kind (WEEKLY|MONTHLY|null) }
- No expiry date is hardcoded. Expiries are whatever Upstox lists, sorted chronologically; an expiry is removed at 15:30 IST on its
  own date (or any earlier date). The nearest valid expiry is the default, and the selection rolls forward automatically after expiry.
  A saved selection that has expired or is no longer listed is replaced by the nearest valid expiry.
- Rows Upstox sends that fail validation are dropped, never repaired. CE/PE are paired by same expiry + same strike; a missing leg stays
  missing (no fake contract). Weekly/monthly is shown only when Upstox sends the `weekly` flag.
- Display: DD-MMM-YYYY and days remaining ("expires TODAY" on the day).
- Not in this part: the option-chain request/quotes (/v2/option/chain) are unchanged.

BASIC LIVE OPTION CHAIN (PART 4)
- src/chain.js  Pure chain logic. Source: Upstox GET /v2/option/chain?instrument_key=NSE_INDEX|Nifty 50&expiry_date=<selected expiry>
- Screen: CALL (Vol, OI, LTP) | STRIKE | PUT (LTP, OI, Vol). ATM row highlighted. ATM +/- N strikes (N = "Strikes each side of ATM",
  also adjustable on the chain card). The selected expiry is shown in a large boxed banner above the table.
- Kept on every row (not shown yet): bid, ask, bid qty, ask qty, previous OI, instrument key (plus Greeks for the analysis engine).
- ATM = strike nearest to the latest valid NIFTY price from the existing Part 1 WebSocket (ties -> lower strike). The chain's own
  underlying_spot_price is never used. No valid price, or a price outside the returned strikes => "ATM UNAVAILABLE", no row is guessed.
- One expiry only: rows Upstox tags with another expiry are dropped; instrument keys are cross-checked against the Part 3 contract
  list; a response that arrives after the user changed expiry is discarded; the analysis engine never sees a chain of another expiry.
- Missing value => "--". Never 0. A real 0 (volume, OI) shows as 0. An LTP of 0 is treated as "no price".
- Status badge: LIVE | STALE | PREVIOUS SESSION | UNAVAILABLE.
    LIVE              market open, chain fetched while open, received < 60 s ago
    STALE             not refreshed, fetched before the open, or the connection is down (last values still shown, dimmed)
    PREVIOUS SESSION  market not open: last session snapshot
    UNAVAILABLE       no chain yet, or the chain on hand is not for the selected expiry
- No new WebSocket. NIFTY price, market status and connection state come from the single Part 1 FeedClient; chain values come from
  REST polling (every "Refresh every" seconds), so option LTP updates at the polling interval, not tick by tick.

OPEN INTEREST ANALYSIS (PART 5)
- src/oi.js  Pure OI logic (tested). Input: the parsed chain of the SELECTED expiry. Uses Upstox market_data.oi (current) and market_data.prev_oi (previous trading day).
- dOI = current OI - previous OI, per option, per strike. If either value is missing/invalid the OI or dOI is null and shows "--" (never 0).
- Shown (card "Open interest analysis", all strikes Upstox returned for the expiry): Highest CALL OI, Highest PUT OI, Largest CALL dOI, Largest PUT dOI
  (largest = biggest buildup, i.e. most positive; the biggest unwinding is shown separately), each with the real strike and OI/change. Ties go to the lower strike.
- OI walls: CALL resistance = strikes at/above NIFTY, PUT support = strikes at/below NIFTY. A wall is a local OI peak (vs. its neighbours on the same side)
  holding >= 60% of the largest OI on that side. Needs a valid NIFTY price from the live feed; without one: "OI WALLS UNAVAILABLE".
- One expiry only: the analysis is refused if the chain is not for the selected expiry or any row carries another expiry (no silent mixing).
- Per-strike table (ATM +/- N strikes setting): CALL OI, CALL change, STRIKE, PUT change, PUT OI; wall strikes are highlighted.
- Not in this part: PCR, IV, signal. The older "OI, PCR and IV" card and the signal engine still use their own ATM +/-5 / +/-10 figures until those parts.

PCR, IV AND GREEKS (PART 6)
- src/pcriv.js  Pure logic (tested). Input: the parsed chain of the SELECTED expiry; refused (like OI) if the chain is for another expiry or holds a foreign row.
- PCR = PUT OI / CALL OI, two clearly labelled numbers:
    Total PCR              all strikes Upstox returned for the expiry
    Near-ATM PCR (ATM +/-5)  the 5 strikes each side of ATM (range shown, e.g. 24250-24750); needs a valid live NIFTY price
  Only strikes where BOTH the CALL and PUT OI exist are counted. CALL OI total of 0 => "--".
- IV (ATM strike = nearest to the live NIFTY price): ATM CALL IV, ATM PUT IV, ATM IV (mean, only when both exist), CALL IV - PUT IV.
  IV <= 0 from Upstox means "no IV" and shows "--".
- Greeks at the ATM strike, CALL and PUT side by side: Delta, Gamma, Theta, Vega, IV, POP - exactly as Upstox sent them ("--" when absent, never derived).
- Rolling history (store.pcrIvHistory): one sample per NEW chain, >= 15 s apart, only for chains requested while the market was OPEN, kept 40 min,
  cleared on expiry change / new login. Change = now vs the sample 4-7 min old closest to 5 min, same expiry only.
  ATM IV change is measured on the SAME strike (so a moving ATM is not mistaken for an IV move).
  Until that history exists the card says "COLLECTING HISTORY (2m 00s of 5m 00s)" - never 0.00 / FLAT. Trend: PCR +/-0.02, IV +/-3 %.
- The old card is now "OI flow context" (volume + the engine's OI/price note); its PCR/IV/Greek rows moved to the new card.
- Not in this part: signal. The signal engine still computes its own PCR/IV figures internally until the signal part.

OPTION LIQUIDITY AND CONTRACT QUALITY (PART 7)
- src/liquidity.js  Pure logic (tested). Input: the parsed chain of the SELECTED expiry; refused (like OI / PCR) if the chain is for another expiry or holds a foreign row.
  Needs a valid live NIFTY price for ATM (no price / price outside the chain => "ATM UNAVAILABLE", nothing is guessed). Contracts judged: ATM +/-5 strikes (adjustable).
- Per contract (CE and PE separately), from what Upstox sent: LTP, OI, volume, bid, ask, bid qty, ask qty, delta, plus
    spread = ask - bid         spread % = spread / mid * 100 (mid = (bid+ask)/2)         depth = the SMALLER of bid qty / ask qty, in lots (lot size from the Part 3 contract list)
  A missing value stays null ("--") and is reported as missing; it is never 0 and never filled from another field.
- Class (tunable defaults in DEFAULT_THRESHOLDS, not market facts):
    metric      GOOD        FAIR        else
    spread %    <= 1        <= 3        POOR
    OI          >= 200,000  >= 50,000   POOR      (units)
    volume      >= 100,000  >= 20,000   POOR      (units)
    depth       >= 5 lots   >= 1 lot    POOR
  POOR if spread or depth is POOR, or if BOTH OI and volume are POOR. GOOD if spread is GOOD, nothing is POOR and at most one metric is only FAIR. Otherwise FAIR.
  A missing OI / volume / depth counts as POOR for that metric (unknown liquidity is not good liquidity).
  UNAVAILABLE = no LTP, no bid, no ask, a crossed book (bid > ask), no contract, or no chain freshness.
  Lot size unknown (Upstox lists differing sizes / none): depth is only "something is quoted on both sides" and no contract can be GOOD.
- Freshness: Upstox sends no per-contract timestamp, so a contract has the freshness of its chain (chainStatus: LIVE | STALE | PREVIOUS SESSION | UNAVAILABLE, with age).
  STALE (incl. connection lost) caps every contract at POOR; PREVIOUS SESSION is graded but not selectable unless includeSnapshot is passed; UNAVAILABLE => every contract UNAVAILABLE.
- rankContracts(input, options) ranks the SUITABLE CE and PE contracts (best first, each with rank, score 0-100, the score components, metrics, class and reasons):
    suitable = inside the ATM window + class >= minClass (default FAIR; 'GOOD' optional) + live chain + delta present, of the right sign (CE > 0, PE < 0) and |delta| in 0.25..0.75
    score    proximity to ATM 20 % + spread 25 % + OI 15 % + volume 15 % + depth 10 % + delta (closest to 0.5) 10 % + freshness 5 %
    ties     higher score, then closer to ATM, then higher volume, then lower strike (fully deterministic)
  Everything not suitable is listed in `rejected` with the reasons (BELOW_MIN_CLASS, WIDE_SPREAD, NO_BID, DELTA_OUT_OF_RANGE, STALE_CHAIN, ...). Options: types ['CE'|'PE'], minClass, delta {min,max,target}, includeSnapshot.
- Screen: card "Option liquidity" = best CE / best PE (+ next two), and the ATM +/-5 table with each contract's class and spread %.
- NOT in this part: no CALL / PUT signal, no change to the signal engine (engine.js keeps its older contract filter until the signal part), no order placement. The module is not imported by engine.js / controller.js (tested).

NIFTY CHART (PART 8)
- src/chartmath.js  Pure chart logic (tested): history merge, per-session VWAP, viewport pan/zoom, geometry, chart status.
- Data: Upstox V3 intraday (today) + historical (previous sessions, chunked to respect per-request range limits), merged by candle
  timestamp. Timeframes 1m 5m 15m 30m 1h (1h = native `hours/1`). Loaded separately from the signal engine's candles, so browsing
  history can never change a CALL / PUT / WAIT decision. Candles come only from Upstox; invalid rows are dropped, none are created.
- Gestures: drag = go back / forward through candles, pinch = zoom (12..300 candles). Buttons: Older, Newer, -, +, Latest.
  The window stays where you left it during the 15 s refresh (only today's candles are re-fetched and merged).
- Shows: price (live feed tick when usable, otherwise last candle close, labelled), session high / low, IST time axis, VWAP (restarts each
  trading day), session separators. Session High/Low and OR/S/R lines are drawn only over their own session's candles.
- States: loading, no data, insufficient candles (< 3), disconnected, stale, market closed (last session dated), live.
- Bottom tab bar: larger labels, taller, lifted above the system navigation area.
- Tests: tests/chartmath.test.mjs, tests/chart-api.test.mjs


NIFTY INTRADAY ANALYTICS (PART 9)
- src/analytics.js  Pure logic (tested). Inputs: the live-feed quote + its freshness, the engine's 1-minute candles + their freshness, market state, the
  exchange-aligned clock and (optionally) the parsed option chain of the selected expiry. UI: src/ui/NiftyAnalyticsCard.js (Dashboard, under "NIFTY market").
  Every value carries its SOURCE (shown as a grey line under it). Missing => "--", never 0.
- Session: market OPEN => TODAY only (yesterday's quote / candles are dropped, never relabelled as live). Market not open => the latest session present,
  labelled TODAY'S SESSION (MARKET CLOSED) or PREVIOUS SESSION dd-MMM-yyyy.
- Price block:
    Current price   feed tick, only while LIVE / FRESH and of the described session. A stale tick is "unavailable" (no fallback to a candle close).
    Open            feed 1d candle; else the open of the 09:15 candle (only if that candle exists).
    High / Low      the larger / smaller of the feed 1d candle and the session's candles; a price beyond that range extends it and is labelled
                    "Live price (day range ... is behind)". A lone price never becomes a day high/low. Pre-open candles (< 09:15) are ignored.
    Previous close  feed only (cp). Missing / 0 => "--".      Day range = High - Low, plus where the price sits in it (0 % = low, 100 % = high).
- VWAP:   volume-weighted VWAP = sum((H+L+C)/3 x volume) / sum(volume), used ONLY if >= 80 % of the candles carry a valid volume > 0.
          NIFTY is an index and Upstox sends volume 0, so in practice the value is the PROXY: the plain average of (H+L+C)/3 over the session's 1-minute
          candles, labelled "Session avg (VWAP proxy)" with a note saying it is not a true VWAP. Restarts every session. The Part 8 chart legend says the same.
- Opening range 09:15-09:30 IST from the CURRENT session's 1-minute candles (high of highs, low of lows):
    FORMING (window running, or the first post-09:30 candle has not arrived) / COMPLETE (all 15 candles present) / INCOMPLETE (a candle is missing) /
    UNAVAILABLE (none). Breakout / breakdown / inside is decided only for a COMPLETE range and a usable price; price == OR high / low is INSIDE.
    A finished range is judged on the candles themselves, so it still shows if the candle refresh is late; candle-based VWAP and momentum are withheld then.
- Support / resistance: day high, day low, OR high / low (only when COMPLETE), the VWAP / session average, and the significant OI walls of the selected expiry
    (Part 5 walls: local OI peaks >= 60 % of the biggest OI on their side), used only from a LIVE / FRESH chain and with a valid price (otherwise the card says why
    they are excluded). Each level lists its source(s); identical prices merge into one level (e.g. "Day high + OR high"). Split by the current price, nearest first;
    without a price the levels are listed unsplit.
- Momentum (context only, NOT a signal): 1m / 5m / 15m / 30m bars built from the 1-minute candles, anchored at 09:15 (not at the epoch), a bar counts only if all of
    its minutes exist, the forming minute is excluded. ROC = close-to-close % change over the last 3 completed bars. POSITIVE / NEGATIVE beyond +/-0.03 % x sqrt(window / 3 min)
    (1m 0.030 %, 5m 0.067 %, 15m 0.116 %, 30m 0.164 %; tunable defaults, not market facts), else FLAT. "fading" = the latest bar moves against the 3-bar move.
    A timeframe without 4 completed bars (or with a missing base bar) is "--" with the reason. Alignment: ALIGNED_UP / ALIGNED_DOWN (>= 2 timeframes agree),
    LEANING_*, MIXED, FLAT, UNAVAILABLE.
- NOT in this part: no CALL / PUT signal. engine.js and controller.js are untouched (tested): the signal engine still uses its own older technicals (looser OR rule,
  1m-epoch bars) until the signal part reconciles them with this module. MarketCard no longer repeats Open/High/Low, previous close, VWAP, OR, momentum and levels.
- Tests: tests/analytics.test.mjs


PROBABILITY-BASED CALL / PUT / WAIT SIGNAL ENGINE - CORE (PART 10A)
- src/signal.js  Pure, deterministic, isolated module (tested). NOT wired into the dashboard, controller, engine.js, alerts or any UI file in this part (tested), and it never
  places or prepares an order. No randomness, no clock reads (the exchange-aligned `now` is an input), no network. Same inputs -> byte-identical output.
- API:  runSignal(snapshot, options)            raw app state -> result (uses the Part 5-9 analysis modules)
        computeSignal(bundle, options)          the same from ready analysis results (analyzeNifty / analyzeOi / analyzePcrIv / analyzeLiquidity)
        evaluateSignalGate(bundle, options)     the data-quality gate alone     formatSignal(result)   plain-text layout     toPercentages(c, p, w)
- Output: signal CALL | PUT | WAIT; probabilities { CALL, PUT, WAIT } (integers 0-100, always summing to EXACTLY 100, largest-remainder rounding);
  confidence HIGH | MEDIUM | LOW; reasons { positive[], negative[], blockers[], neutral[], missing[], lines[] }; plus gate, factors, vetoes, scores, quality.
  The numbers are INTERNAL MODEL SCORES / ESTIMATED PROBABILITIES, not statistically guaranteed market probabilities (result.disclaimer says so).
- DATA-QUALITY GATE (evaluated BEFORE any CALL / PUT scoring; all 11 checks are always reported, no short-circuit). Any failure => WAIT 100 / CALL 0 / PUT 0,
  confidence LOW, reasons name every failed check, and no directional score is calculated at all (a genuine WAIT, never a disguised fallback):
    market status | NIFTY freshness | option-chain freshness | required option data (OI, PCR, ATM strike, ATM delta + price) | current-session candles |
    minimum history (>= 30 completed candles, a momentum timeframe, VWAP) | selected expiry (not expired, chain is for it, no foreign rows) | feed connection |
    liquidity data (OI, volume, depth of both ATM contracts) | bid/ask spread (both ATM legs two-sided, not both too wide) |
    data consistency (live price vs last candle, chain underlying vs NIFTY, candle gaps).
  Checks 1, 2, 5, 8 reuse the Part 2 gate (src/feed/gate.js), so the dashboard and the engine can never disagree about them.
- FACTORS (score -1..+1, fixed weight, plain-language reason; a missing input keeps its weight in the denominator, so it LOWERS the score instead of being guessed):
    NIFTY   VWAP/session-average position 12, opening range 12, momentum 10, trend (EMA9 vs EMA21) 8, structure (3-minute swings) 10
    OPTIONS OI walls 12, ATM+/-5 dOI flow 12, near-ATM PCR 8, total PCR 4, IV change vs price 6
    VOLATILITY India VIX change 6      GLOBAL  3 (fresh equity indices only; stale / delayed / too few items => not used)
  Option volume, liquidity, spread and theta/Greeks act as WAIT pressure and as contract-quality vetoes, not as direction.
- PROBABILITIES: callN = sum(w * max(s,0)) / total weight, putN likewise; WAIT score = base + conflict (min(callN, putN)) + chop + VIX shock + theta decay + thin
  liquidity + missing inputs + low data quality; probabilities = softmax(K * score), then rounded to integers that sum to 100.
- VETOES (a directional signal is only given when none stands; WAIT then becomes the largest probability and says why): thin input coverage; price action and
  option flow must BOTH lean the same way (agreement of independent signals); < 40 % or < 15-point lead; opposing OI wall within 0.12 % of price; chosen ATM
  contract illiquid / wide spread; an edge that exists only because of global data.
- CONFIDENCE (deterministic ladder): HIGH = lead >= 35 pts, agreement >= 0.8, data quality >= 0.85, coverage >= 0.85;  MEDIUM = 20 / 0.6 / 0.65 / 0.7;  else LOW.
  A failed gate is always LOW; a vetoed WAIT is never HIGH. All thresholds / weights live in CFG / WEIGHTS and can be overridden through options.cfg.
- NOT in this part: no dashboard / UI change, no controller wiring, no alerts, no order placement or broker execution. engine.js still drives the existing SignalCard.
- Tests: tests/signal.test.mjs (npm test)


SIGNAL ENGINE TESTS + SAFE INTEGRATION (PART 10B)
- src/signalBridge.js  Pure adapter (tested). The ONLY importer of src/signal.js. app state -> runSignal -> validated result -> the fields the existing UI reads.
- WIRING: controller.js computes the engine result every cycle (after the legacy analysis) and merges it into store.analysis. The visible SIGNAL, probabilities,
  CONFIDENCE, REASONS and data-gate status come from the new engine; the legacy CALL / PUT / WAIT is overridden. The UI layout is unchanged:
    SignalCard   signal word, Confidence HIGH / MEDIUM / LOW, "Data gate: PASSED / FAILED (n checks)" + every failed check, CALL / PUT / WAIT % bars, supporting + opposing reasons.
    ExplainCard  weighted factors from the engine, WAIT blockers, missing inputs.        Alerts  CALL / PUT / WAIT->CALL / WAIT->PUT fire from the new signal only.
  A legacy "Recommended contract" card is shown only if it is for the same side as the new signal (never under WAIT or the opposite side).
- PROBABILITY WORDING: every place that shows the three percentages also shows "Internal model score / estimated probability; not a statistical guarantee."
  (src/signal.js PROBABILITY_NOTE, single source). Confidence is a label, not a percentage. Settings > Signal tuning no longer changes the signal (note added there).
- SAFETY NET (signalBridge.evaluateSignal): the engine result is re-validated before the UI sees it. A CALL / PUT is accepted only if the gate passed, CALL/PUT/WAIT are
  integers 0..100 summing to exactly 100, no veto stands, the direction is strictly the largest probability and it has reasons. Any exception or failed check => WAIT 100
  with the problem named. Between two engine cycles (~5 s) withdrawIfStale() re-applies the Part 2 gate + chain freshness to the live state, so a CALL / PUT is withdrawn
  the moment the feed drops or NIFTY / candles / chain go stale; a failed analysis cycle also clears the previous direction.
- NOT in this part (and absent from the whole app, tested): any order placement, broker call or automatic trading.
- Tests: tests/signal-integration.test.mjs (+ tests/signal-fixtures.mjs shared with tests/signal.test.mjs): the 12 data-quality conditions (each x bullish/bearish scene),
  8 directional fixtures, OI-wall conflict sweeps, 600 deterministic random scenes for probability invariants, determinism (25 identical runs, no randomness / clock),
  explainability (reasons match input data, nothing fabricated), disclaimer wording, bridge safety net with fault injection, controller / UI / alert wiring, no-trading scan.
