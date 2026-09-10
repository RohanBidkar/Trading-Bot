# Stock Scanner → Telegram

Two automated daily scanners for US regional-bank stocks (plus a few ETFs).
After the US close they check every ticker and send Telegram alerts: an
**oversold** (long-side) scan and an **overbought** (short-side) scan. Both run
automatically on a schedule, and either can be triggered on demand from a
Telegram button.

A third, on-demand report ranks the whole list by how it performed over the
**first five trading days of a month**.

| Piece | Where it runs | What it does |
| --- | --- | --- |
| `scanner_core.py` | — | Shared data fetch, indicators, tables, Telegram send |
| `oversold_scanner.py` | GitHub Actions | Long-side screen |
| `overbought_scanner.py` | GitHub Actions | Short-side screen |
| `first_five_scanner.py` | GitHub Actions | Month-open performance ranking (on demand) |
| `telegram_trigger_worker.js` | Cloudflare Workers | Telegram menu to run any of them on demand |

## Strategy logic

Four setups across two scripts, all evaluated on the most recent completed
daily bar. Each script reports any ticker matching either of its setups; a
ticker matching both appears in both tables.

### Oversold — `oversold_scanner.py`

**Setup A — Below SMA20.** All three must hold:

1. `Close < SMA20`
2. Far enough below, **scaled by share price**: > $100 needs **4%**, ≤ $100 needs **3%**
3. `RSI(14) <= 40`

**Setup B — Sharp drop.** One condition, independent of SMA and RSI:

- `Close` is **10%+ below** where it was **10 trading days** ago

### Overbought — `overbought_scanner.py`

The exact mirror:

**Setup C — Above SMA20.**

1. `Close > SMA20`
2. Far enough above: > $100 needs **+4%**, ≤ $100 needs **+3%**
3. `RSI(14) >= 60`

**Setup D — Sharp rise.**

- `Close` is **10%+ above** where it was **10 trading days** ago

The sharp-move setups catch fast moves that the SMA setups miss — a stock can
run hard and still sit near its 20-day average, because the average has not
caught up yet.

The price tier exists because higher-priced names move more in dollar terms; a
3% move on a $150 stock is ordinary noise, while on a $30 stock it is real. The
cutoff is exclusive — exactly $100.00 falls in the lower (3%) tier.

Thresholds live at the top of each scanner (`PCT_DROP_*` / `RSI_OVERSOLD` /
`DROP_THRESHOLD`, and `PCT_RISE_*` / `RSI_OVERBOUGHT` / `RISE_THRESHOLD`).
Shared settings — `TICKERS`, `SMA_LEN`, `RSI_LEN`, `PRICE_TIER`,
`MOVE_LOOKBACK` — live in `scanner_core.py`.

Note the two sides are not symmetric in practice. On this list the binding
constraint for the short side is the **distance** requirement, not RSI: these
banks rarely extend 4–5% above their 20-day average, so Setup C fires less
often than you might expect.

### First five days — `first_five_scanner.py`

Not a screen — a **ranking**. It reports every ticker, sorted by its return
over the opening sessions of a month, and is the classic "first five days"
read on where money went as the month turned.

The return is measured **from the previous month's closing price** to the close
of the 5th trading day, so a gap up on the first session counts. Nothing is
filtered: all 44 names appear, split into an up table and a down table, with a
one-line summary underneath.

```
First 5 trading days of September 2026
2026-09-01 → 2026-09-08 — measured from the prior close

🟢 Up
STK        PREV     LAST     RET
--------------------------------
HIFS     288.27   310.59    7.7%
ESQ      111.72   118.28    5.9%

🔴 Down
...

36 up / 8 down of 44 — average +1.6%, 3 moved 5%+
```

`PREV` is the prior month's closing price, `LAST` the close of the final
session in the window. The date line spans the actual sessions used, which is
why September 2026 runs to the 8th — the 7th was Labor Day.

Run it mid-month and it uses whatever sessions exist so far, saying `(partial)`
in the header and naming the real count (`First 3 trading days of …`). It is
never silent: unlike the two screens, this report always has rows.

Settings live at the top of the script: `DEFAULT_DAYS` (5), `STRONG_MOVE` (the
5% cutoff for the movers count), and `PERIOD` (3 years of bars, enough for any
month the Telegram picker offers).

### Alert format

Matches are sent as fixed-width tables, most stretched first, wrapped in
Telegram `<pre>` blocks so the columns stay aligned in a monospace font:

```
STK       CLOSE    DIFF    SMA20    RSI     D10
-----------------------------------------------
JBSS      72.43   -7.4%    78.21   32.0  -11.8%
```

The second column is `DIFF` (% versus SMA20) in the SMA tables and `D10`
(% over the last 10 sessions) in the sharp-move tables. The SMA tables carry
`D10` again as a trailing column, so the 10-day move is visible next to RSI;
the sharp-move tables drop it, since it is already their metric column. The
first-five report uses its own columns (`PREV` / `LAST` / `RET`) and always
sends.

**Every run reports back**, including quiet ones:

```
Overbought scan — bar 2026-09-08

No matches — 44 tickers scanned.
```

Silence is indistinguishable from a broken run, so an empty scan says so
explicitly. Set `NOTIFY_WHEN_EMPTY=0` in the environment to go back to
alert-only delivery — useful on the scheduled run if two "no matches" messages
a day become noise, while on-demand scans keep confirming they worked. A run
that cannot fetch any data at all sends a distinct ⚠️ warning instead.

Data source is yfinance, ~6 months of daily bars per ticker (enough history to
warm up both a 20-bar SMA and a 14-bar RSI). Each ticker is wrapped in its own
try/except, so a delisted or mistyped symbol logs an error and the rest of the
run continues. A Telegram message is only sent when there is at least one match.

### Why raw Close (and the Adjusted Close tradeoff)

Indicators are computed on **raw, unadjusted Close** so the SMA20 and RSI match
what a standard charting platform shows. `yf.download(..., auto_adjust=False)`
is passed explicitly and is load-bearing: recent yfinance versions default
`auto_adjust=True`, which silently back-adjusts the `Close` column for
dividends and splits. Without the flag you would get adjusted numbers under the
`Close` name.

The tradeoff is real and worth understanding. Adjusted Close marks historical
bars down by any dividend paid since, so an ex-dividend date sitting inside the
20-day window moves the average. A worked example from this list — JBSS, $2.00
dividend with ex-date 2026-08-17:

| Series | Close | SMA20 | % vs SMA | RSI |
| --- | --- | --- | --- | --- |
| raw Close | 72.43 | 78.21 | -7.39% | 32.03 |
| Adj Close | 72.43 | 77.72 | -6.80% | 33.25 |

Roughly seven bars in that window predate the ex-date and get marked down by
$2, lowering the adjusted average. RSI shifts too: on raw Close the ex-day drop
reads as a down day, while adjusting removes it as the cash payout it was.

So raw Close can flag a stock whose "drop" was partly a dividend payment. These
are dividend-heavy regional banks, so expect this several times a year per
name. If you would rather screen on total-return behaviour, switch
`get_close()` to return `df["Adj Close"]` instead of `df["Close"]` — the
`auto_adjust=False` call already fetches both columns.

### RSI

RSI(14) is computed manually in pandas (no ta-lib) using **Wilder's
smoothing** — an EMA with `alpha = 1/14`, via
`ewm(alpha=1/14, adjust=False)`. This matches the RSI you see on TradingView
and StockCharts. A plain `rolling(14).mean()` is a different (and less
standard) indicator that will disagree with your charts.

## Local setup and a test run

```bash
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

Requires Python 3.11+ (`pandas` 3.x). Set the two environment variables — the
scripts fall back to obvious placeholders and refuse to send if unset:

```bash
cp .env.example .env               # then fill in real values
export TELEGRAM_TOKEN="123456789:AAExample..."
export TELEGRAM_CHAT_ID="987654321"
```

- **`TELEGRAM_TOKEN`** — create a bot with [@BotFather](https://t.me/BotFather) (`/newbot`)
- **`TELEGRAM_CHAT_ID`** — message [@userinfobot](https://t.me/userinfobot) for your numeric id.
  Send your bot a message first, or it is not allowed to message you.
  Several recipients can be comma-separated: `123456789,-1001234567890,@mychannel`

Run either scanner:

```bash
python oversold_scanner.py
python overbought_scanner.py
```

The month-open report is its own script:

```bash
python first_five_scanner.py                  # latest month with 5 sessions
python first_five_scanner.py --month 2026-03  # a specific month, print only
python first_five_scanner.py --month 2026-03 --send
python first_five_scanner.py --days 3         # count 3 sessions, not 5
```

With no `--month` it picks the current month once five sessions have printed,
and the previous one before that — so early in a month you get the last
complete window rather than a two-day sliver. As with `--as-of`, naming a month
prints only unless you add `--send`.

### Running as of an earlier date

Both scripts take `--as-of` to reproduce what they would have printed on a past
trading day. A weekend or holiday rolls back to the previous session:

```bash
python oversold_scanner.py --as-of 2026-09-01
python oversold_scanner.py --as-of 2026-09-01 --send   # also push to Telegram
```

Historical runs print only by default — `--send` is required to deliver one, so
a backtest cannot accidentally spam your alerts.

Two caveats. It is **point-in-time on today's ticker list**, so anything
delisted or acquired is missing and results are survivorship-biased — fine for
spot checks, not a real backtest. And enough history must precede the target
date; `--as-of` automatically widens the download to 2 years, which covers most
of what you would want.

## Deploy the GitHub Actions workflow

`.github/workflows/daily_scan.yml` runs at **21:30 UTC, Mon–Fri** — 4:30pm ET
during daylight saving, 5:30pm ET in winter (GitHub cron is always UTC, and
both are after the 4:00pm ET close). Scheduled runs execute **both** scanners,
which send two separate Telegram messages.

It also supports **workflow_dispatch** with a `scan` input — `both` (default),
`oversold`, `overbought`, or `first5` — so you can run one side by hand from
the Actions tab, or from the Telegram menu via the Worker. `both` still means
the oversold/overbought pair; `first5` is on demand only and never runs on the
schedule. Two text inputs go with it: `as_of` (a session, for the two screens)
and `month` (a `YYYY-MM`, for `first5`); both blank means "the latest".

After pushing the repo:

1. Go to **Settings → Secrets and variables → Actions → New repository secret**
2. Add `TELEGRAM_TOKEN`
3. Add `TELEGRAM_CHAT_ID`
4. Open the **Actions** tab, pick *Daily Oversold Scan*, and hit **Run workflow**
   to confirm it works end to end

Note: GitHub disables scheduled workflows in repos with no activity for 60
days, and scheduled runs can be delayed by several minutes at busy times.

## Deploy the Cloudflare Worker (separate deploy)

The worker is standalone — it is not part of the GitHub Actions deploy. It
receives the Telegram webhook and dispatches the workflow so you can run a scan
on demand.

Telegram commands:

| Command | Runs |
| --- | --- |
| `/start` or `/menu` | Shows inline buttons: 📉 Oversold, 📈 Overbought, 🔀 Both, 📅 Pick a date, 🗓 First 5 days |
| `/scan` or `/oversold` | Oversold scan on the latest bar |
| `/short` or `/overbought` | Overbought scan on the latest bar |
| `/both` | Both |
| `/scan 2026-09-01` | Oversold scan **as of that session** |
| `/short 2026-09-01` | Overbought scan as of that session |
| `/both 2026-09-01` | Both, as of that session |

The month-open report has **no text command** — it is the 🗓 **First 5 days**
button on the `/start` menu, because it needs a month rather than a date.

Anything else gets a one-line usage hint.

### Picking a date from a calendar

`/start` → **📅 Pick a date** → choose a side → a month grid appears in the
chat:

```
      ◀   September 2026
   Mo  Tu  We  Th  Fr  Sa  Su
        1   2   3   4   ·   ·
    7   8   ·   ·   ·   ·   ·
```

`◀ ▶` redraw the same message a month at a time; tapping a day dispatches the
scan for that session. Weekends and future dates render as an inert `·`, and
navigation stops at 24 months back — matching `LOOKBACK_HISTORICAL` in
`scanner_core.py`, beyond which there is not enough history to warm up SMA20.
Market holidays stay selectable because the scanner rolls back to the previous
session anyway.

### Picking a month for the first-five report

`/start` → **🗓 First 5 days** → a year of months appears:

```
      ◀   2026   
   Jan Feb Mar Apr
   May Jun Jul Aug
   Sep  ·   ·   ·
```

Same idea one level up: `◀ ▶` redraw the same message a year at a time, and
future or out-of-horizon months are an inert `·`. Tapping a month dispatches
the report for it. There is no side to choose first — the report covers every
ticker, up and down together.

It is built entirely from inline keyboards, so there is no extra hosted page
and it works in groups. Everything routes through `callback_data` (`run:`,
`cal:`, `nav:`, `day:`, `months`, `yr:`, `mo:`, `noop`), which stays well
inside Telegram's 64-byte limit.

The date is validated in the Worker before it goes anywhere: exact
`YYYY-MM-DD`, a real calendar date, and not in the future. Months get the same
treatment — exact `YYYY-MM`, month `01`–`12`, not in the future — even though
they only ever arrive from our own grid, since `callback_data` comes over the
wire like any other input. Bad input gets a reply explaining the format rather
than a dispatch. The workflow then passes both to the scripts through `env:`
variables, quoted — never interpolated into the shell line — so a hostile input
cannot escape into the runner.

A backdated scan is delivered to every id in `TELEGRAM_CHAT_ID`, not only the
person who asked.

```bash
npm install -g wrangler
wrangler login
wrangler deploy telegram_trigger_worker.js --name telegram-trigger --compatibility-date 2025-01-01
```

Then set its secrets (each prompts for the value, nothing is written to disk):

```bash
wrangler secret put TELEGRAM_TOKEN         --name telegram-trigger
wrangler secret put TELEGRAM_SECRET_TOKEN  --name telegram-trigger
wrangler secret put GITHUB_TOKEN           --name telegram-trigger
wrangler secret put GITHUB_OWNER           --name telegram-trigger
wrangler secret put GITHUB_REPO            --name telegram-trigger
wrangler secret put GITHUB_BRANCH          --name telegram-trigger
```

| Variable | Value |
| --- | --- |
| `TELEGRAM_TOKEN` | Same bot token as the scanner; the worker uses it to reply |
| `TELEGRAM_SECRET_TOKEN` | A random string you invent — the shared secret below |
| `GITHUB_TOKEN` | Fine-grained PAT scoped to this repo with **Actions: read & write** |
| `GITHUB_OWNER` | Your GitHub username or org |
| `GITHUB_REPO` | The repo name, e.g. `alert-bot` |
| `GITHUB_BRANCH` | Branch to dispatch against, e.g. `main` |

### Point Telegram at the worker (run once)

```bash
curl -s "https://api.telegram.org/bot<TELEGRAM_TOKEN>/setWebhook?url=https://telegram-trigger.<your-subdomain>.workers.dev&secret_token=<TELEGRAM_SECRET_TOKEN>"
```

Telegram then sends that `secret_token` back on every request in the
`X-Telegram-Bot-Api-Secret-Token` header; the worker rejects anything that
does not match with a 403, so nobody else can trigger your workflow.

Verify with `https://api.telegram.org/bot<TELEGRAM_TOKEN>/getWebhookInfo`, then
send `/scan` to your bot. Any other message gets a one-line usage hint back.

Caveat: `workflow_dispatch` only works once `daily_scan.yml` exists on the
default branch — push the repo before testing the worker.

## Repo layout

```
scanner_core.py                  # shared: fetch, indicators, tables, Telegram
oversold_scanner.py              # long-side setups (A + B)
overbought_scanner.py            # short-side setups (C + D)
first_five_scanner.py            # month-open performance ranking (on demand)
requirements.txt                 # pinned yfinance / pandas / requests
.github/workflows/daily_scan.yml # daily cron + manual trigger with scan input
telegram_trigger_worker.js       # Cloudflare Worker: Telegram menu -> dispatch
set_webhook.py                   # one-time helper to register the webhook
.env.example                     # variables to fill in locally
wrangler.jsonc                   # Worker deploy config
```

## Disclaimer

This is a screening tool, not investment advice. It flags a mechanical
condition on delayed/end-of-day data; verify anything it surfaces before
acting on it.
