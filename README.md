# Oversold Scanner → Telegram

A free, automated daily scanner for US bank/regional-bank stocks (plus a few
ETFs). It checks every ticker after the US close and sends a single Telegram
message listing any that are stretched below their 20-day moving average.

Two pieces, deployed independently:

| Piece | Where it runs | What it does |
| --- | --- | --- |
| `oversold_scanner.py` | GitHub Actions (cron) | Pulls prices, evaluates the setup, sends the alert |
| `telegram_trigger_worker.js` | Cloudflare Workers | Lets you type `/scan` in Telegram to run it on demand |

## Strategy logic

Two independent setups run on the most recent completed daily bar. A ticker
matching either one is reported; matching both puts it in both tables.

**Setup A — Below SMA20.** All three must hold:

1. `Close < SMA20` — trading below the 20-day simple moving average
2. Far enough below that average, **scaled by share price**:
   - Close > $100 → at least **5%** below SMA20
   - Close ≤ $100 → at least **4%** below SMA20
3. `RSI(14) <= 40` — momentum is weak, not just the price

**Setup B — Sharp drop.** A single condition, independent of the SMA and RSI:

- `Close` is **10% or more below** where it was **10 trading days** ago

Setup B catches fast selloffs that Setup A can miss — a stock can fall hard and
still sit near its 20-day average if the drop is recent enough.

The price tier exists because higher-priced names move more in dollar terms; a
4% dip on a $150 stock is ordinary noise, while on a $30 stock it is a real
move. The cutoff is exclusive — exactly $100.00 falls in the 4% tier.

Constants live at the top of `oversold_scanner.py` — `SMA_LEN`, `RSI_LEN`,
`PRICE_TIER`, `PCT_DROP_ABOVE_TIER`, `PCT_DROP_BELOW_TIER`, `RSI_THRESHOLD`
for Setup A, and `DROP_LOOKBACK` / `DROP_THRESHOLD` for Setup B. Set both tier
percentages to the same value to go back to a single flat threshold.

### Alert format

Matches are sent as fixed-width tables, most stretched first, wrapped in
Telegram `<pre>` blocks so the columns stay aligned in a monospace font:

```
STK       CLOSE    DIFF    SMA20    RSI
---------------------------------------
JBSS      72.43   -7.4%    78.21   32.0
```

The second column is `DIFF` (% versus SMA20) in the Setup A table and `D10`
(% over the last 10 sessions) in the Setup B table. A message is sent only when
at least one setup has a match.

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

## Local setup and a single test run

```bash
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

Set the two environment variables (the script falls back to obvious
placeholder strings if you skip this — it will run and print matches, but the
Telegram send will fail):

```bash
cp .env.example .env               # then fill in real values
export TELEGRAM_TOKEN="123456789:AAExample..."
export TELEGRAM_CHAT_ID="987654321"
```

- **`TELEGRAM_TOKEN`** — create a bot with [@BotFather](https://t.me/BotFather)
  (`/newbot`) and copy the token it gives you.
- **`TELEGRAM_CHAT_ID`** — message [@userinfobot](https://t.me/userinfobot); it
  replies with your numeric id. Send your own bot a message once first, or it
  is not allowed to message you.

Run it once:

```bash
python oversold_scanner.py
```

You will see either the alert text (also sent to Telegram) or
`No matches today.`

## Deploy the GitHub Actions workflow

`.github/workflows/daily_scan.yml` runs at **21:30 UTC, Mon–Fri** — 4:30pm ET
during daylight saving, 5:30pm ET in winter (GitHub cron is always UTC, and
both are after the 4:00pm ET close). It also supports **workflow_dispatch**, so
you can run it by hand from the Actions tab.

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
receives the Telegram webhook and dispatches the workflow so `/scan` runs the
scanner on demand.

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
oversold_scanner.py              # the scanner
requirements.txt                 # pinned yfinance / pandas / requests
.github/workflows/daily_scan.yml # daily cron + manual trigger
telegram_trigger_worker.js       # Cloudflare Worker for /scan
.env.example                     # variables to fill in locally
```

## Disclaimer

This is a screening tool, not investment advice. It flags a mechanical
condition on delayed/end-of-day data; verify anything it surfaces before
acting on it.
