"""
Shared machinery for the daily scanners.

Holds everything both sides need - price download, indicators, table
formatting, Telegram delivery, CLI parsing - so oversold_scanner.py and
overbought_scanner.py only declare their own thresholds and predicates.

All calculations use raw (unadjusted) Close so the numbers line up with a
standard charting platform. See README for the Adjusted Close tradeoff.
"""

import argparse
import math
import os
import re
import time
from dataclasses import dataclass
from datetime import date
from html import escape
from typing import Callable

import pandas as pd
import requests
import yfinance as yf

# ---------------- SHARED CONFIG ----------------
# The built-in watchlist. The live list is edited on the website and fetched
# by load_tickers() below; this is what runs when the site can't be reached
# (or a local run with no RESULTS_URL). Keep in step with web_api.js.
DEFAULT_TICKERS = [
    "SFST", "HBCP", "UNTY", "OBT", "PFIS", "MCBS", "CAC", "CCBG", "JBSS", "SPFI",
    "CBNK", "RBCAA", "SMBC", "THFF", "FCBC", "HWBK", "FBIZ", "CHMG", "MBWM", "GSBC",
    "PKBK", "PLBC", "FRAF", "CCB", "FCAP", "CMTV",
    "BFC", "BANF", "NBN", "BOKF", "BPOP", "CHCO", "ESQ", "EWBC", "FCNCA", "HIFS",
    "PFBC", "QCRH", "RRBI", "UMBF", "WTFC", "DPST", "KRE", "HOV",
]

# Send a "no matches" message too, so a scan never ends in silence. Set to
# 0/false to go back to alert-only delivery.
NOTIFY_WHEN_EMPTY = os.environ.get("NOTIFY_WHEN_EMPTY", "1").strip().lower() not in (
    "0", "false", "no", "off", "",
)

TELEGRAM_TOKEN = os.environ.get("TELEGRAM_TOKEN", "YOUR_BOT_TOKEN_HERE")
# One id, or several separated by commas: "123456789,-1001234567890,@mychannel"
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "YOUR_CHAT_ID_HERE")

# Runs dispatched from the website pass SEND_TELEGRAM=0: their results stay on
# the website. Telegram-started runs leave it on.
SEND_TELEGRAM = os.environ.get("SEND_TELEGRAM", "1").strip().lower() not in (
    "0", "false", "no", "off",
)

# Where the website receives results (see web_api.js). All three are set by
# the workflow; left unset - e.g. a local run - nothing is posted.
RESULTS_URL = os.environ.get("RESULTS_URL", "").strip().rstrip("/")
RESULTS_SECRET = os.environ.get("RESULTS_SECRET", "").strip()
RUN_ID = os.environ.get("RUN_ID", "").strip()


# A watchlist group id from the website (set by the workflow); blank = all.
WATCHLIST_GROUP = os.environ.get("WATCHLIST_GROUP", "").strip()
# The group's name once loaded, shown at the top of Telegram messages.
WATCHLIST_LABEL = ""


def load_tickers() -> list:
    """The website's watchlist (one group, or all), else DEFAULT_TICKERS.

    A failed fetch never stops a scan - it runs on the built-in list and says so.
    """
    global WATCHLIST_LABEL
    if not (RESULTS_URL and RESULTS_SECRET):
        return list(DEFAULT_TICKERS)
    try:
        resp = requests.get(
            f"{RESULTS_URL}/api/results/watchlist",
            params={"group": WATCHLIST_GROUP} if WATCHLIST_GROUP else None,
            headers={"Authorization": f"Bearer {RESULTS_SECRET}"},
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()
        tickers = [str(t).strip().upper() for t in data.get("tickers", []) if str(t).strip()]
        if tickers:
            group = data.get("group") or {}
            WATCHLIST_LABEL = group.get("name", "")
            print(f"Watchlist: {len(tickers)} tickers from the website ({WATCHLIST_LABEL or 'all groups'})")
            return tickers
        print("Website returned an empty watchlist; using the built-in list")
    except Exception as exc:
        print(f"Could not fetch the watchlist ({exc}); using the built-in list")
    if WATCHLIST_GROUP:
        WATCHLIST_LABEL = "built-in list (group unavailable)"
    return list(DEFAULT_TICKERS)


TICKERS = load_tickers()

SMA_LEN = 20
RSI_LEN = 14
PRICE_TIER = 100.0      # dollar cutoff between the two distance tiers
MOVE_LOOKBACK = 10      # trading days for the sharp move setups

LOOKBACK = "6mo"        # enough history for a scan of the latest bar
LOOKBACK_HISTORICAL = "2y"   # used when --as-of walks back in time
# -----------------------------------------------


@dataclass
class Setup:
    """One screen: a title, which metric to show, and how to match/sort."""

    title: str
    column: str                      # header for the second column
    key: str                         # metric shown under that header
    predicate: Callable[[dict], bool]
    descending: bool = False         # sort direction for the metric


def tier_threshold(close: float, above: float, below: float) -> float:
    """Pick the threshold for a share price, split at PRICE_TIER."""
    return above if close > PRICE_TIER else below


def sort_by_tier(rows: list, key: str, price: str = "close", descending: bool = False) -> list:
    """Sort by `key`, with every name at or under PRICE_TIER listed first.

    The metric order holds within each tier; the second sort is stable, so it
    only moves the over-$100 names below the rest.
    """
    ordered = sorted(rows, key=lambda m: m[key], reverse=descending)
    return sorted(ordered, key=lambda m: m[price] > PRICE_TIER)


def compute_rsi(series: pd.Series, length: int = RSI_LEN) -> pd.Series:
    """RSI using Wilder's smoothing (what TradingView / StockCharts show).

    Wilder's average is an EMA with alpha = 1/length, which is why we use
    ewm(alpha=...) rather than a plain rolling mean.
    """
    delta = series.diff()
    gain = delta.clip(lower=0.0)
    loss = -delta.clip(upper=0.0)

    avg_gain = gain.ewm(alpha=1.0 / length, adjust=False, min_periods=length).mean()
    avg_loss = loss.ewm(alpha=1.0 / length, adjust=False, min_periods=length).mean()

    rs = avg_gain / avg_loss
    rsi = 100.0 - (100.0 / (1.0 + rs))
    # avg_loss == 0 means an unbroken run of up days -> RSI is 100 by definition
    return rsi.where(avg_loss != 0, 100.0)


# ---------------- PRICE DOWNLOADS ----------------
# The watchlist is fetched in batches instead of one request per ticker, and
# kept in a short-lived file cache so the second script of a "both" run (a
# separate process in the same job) reuses the first one's download.
BATCH_SIZE = 50
CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".price_cache")
CACHE_TTL = 30 * 60     # seconds; long enough for one workflow run

_closes = {}            # period -> {ticker: Close series}
_batched = set()        # periods whose watchlist batch already ran


def _download_one(ticker: str, period: str) -> pd.Series:
    """Download one ticker's daily bars and return the raw (unadjusted) Close.

    auto_adjust=False is essential: newer yfinance defaults it to True, which
    back-adjusts 'Close' for dividends and splits. We want the untouched
    printed close, so ask for unadjusted data explicitly.
    """
    df = yf.download(
        ticker,
        period=period,
        interval="1d",
        auto_adjust=False,
        progress=False,
        threads=False,
    )

    if df is None or df.empty:
        raise ValueError("no data returned")

    # yfinance may return MultiIndex columns (field, ticker) even for one symbol
    if isinstance(df.columns, pd.MultiIndex):
        df = df.xs(ticker, axis=1, level=-1)

    if "Close" not in df.columns:
        raise ValueError("'Close' column missing from response")

    return df["Close"].dropna()


def _download_batch(tickers: list, period: str) -> dict:
    """Close series for many tickers, BATCH_SIZE per request. Misses are left out."""
    out = {}
    for i in range(0, len(tickers), BATCH_SIZE):
        chunk = tickers[i:i + BATCH_SIZE]
        try:
            df = yf.download(
                chunk,
                period=period,
                interval="1d",
                auto_adjust=False,   # raw printed close, as in _download_one
                progress=False,
                threads=True,
                group_by="column",
            )
        except Exception as exc:
            print(f"Batch download failed ({exc}); fetching those {len(chunk)} one by one")
            continue
        if df is None or df.empty or not isinstance(df.columns, pd.MultiIndex):
            continue
        if "Close" not in df.columns.get_level_values(0):
            continue
        close = df["Close"]
        for t in chunk:
            if t in close.columns:
                # Mixed exchanges share one date index; each ticker's own
                # non-trading days come back as NaN and are dropped here.
                series = close[t].dropna()
                if not series.empty:
                    out[t] = series
    return out


def _cache_path(period: str) -> str:
    return os.path.join(CACHE_DIR, f"close_{re.sub(r'[^A-Za-z0-9]', '', period)}.pkl")


def _read_cache(period: str) -> dict:
    """This period's cached closes, if written by this run (younger than CACHE_TTL)."""
    path = _cache_path(period)
    try:
        if time.time() - os.path.getmtime(path) < CACHE_TTL:
            data = pd.read_pickle(path)   # only ever a file this module wrote
            if isinstance(data, dict):
                return data
    except Exception:
        pass
    return {}


def _write_cache(period: str, closes: dict) -> None:
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
        tmp = _cache_path(period) + ".tmp"
        pd.to_pickle(closes, tmp)
        os.replace(tmp, _cache_path(period))
    except Exception as exc:
        print(f"Could not write the price cache: {exc}")


def get_close(ticker: str, period: str = LOOKBACK) -> pd.Series:
    """The raw (unadjusted) daily Close for one ticker.

    The first watchlist ticker asked for triggers one batched download of the
    whole watchlist for that period; later calls are served from memory. A
    ticker the batch missed - and any symbol not on the watchlist, such as the
    forex pairs - is downloaded on its own, exactly as before.
    """
    if period not in _closes:
        _closes[period] = _read_cache(period)
        if _closes[period]:
            print(f"Prices: reusing {len(_closes[period])} cached tickers ({period})")
    cache = _closes[period]

    if ticker not in cache and ticker in TICKERS and period not in _batched:
        _batched.add(period)
        missing = [t for t in TICKERS if t not in cache]
        started = time.time()
        got = _download_batch(missing, period)
        print(f"Prices: {len(got)}/{len(missing)} tickers in one batch ({period}, {time.time() - started:.1f}s)")
        cache.update(got)
        if got:
            _write_cache(period, cache)

    if ticker in cache:
        return cache[ticker]

    series = _download_one(ticker, period)
    cache[ticker] = series
    return series


def evaluate(ticker: str, as_of: date = None, period: str = LOOKBACK, moves: tuple = ()):
    """Metrics for one ticker as of the last bar on or before `as_of`.

    `moves` lists extra lookbacks in trading days; each adds a `d<N>` key with
    the % change over that many sessions.
    """
    prices = get_close(ticker, period)

    if as_of is not None:
        # Truncate to what was knowable that day; a weekend or holiday rolls
        # back to the previous trading session.
        prices = prices[prices.index.date <= as_of]

    needed = max(SMA_LEN + RSI_LEN, MOVE_LOOKBACK + 1, *(n + 1 for n in moves))
    if len(prices) < needed:
        print(f"Skipping {ticker}: only {len(prices)} bars of usable history")
        return None

    close = float(prices.iloc[-1])
    sma = float(prices.rolling(SMA_LEN).mean().iloc[-1])
    rsi = float(compute_rsi(prices, RSI_LEN).iloc[-1])
    past = float(prices.iloc[-(MOVE_LOOKBACK + 1)])

    if pd.isna(sma) or pd.isna(rsi) or sma == 0 or past == 0:
        print(f"Skipping {ticker}: indicators not ready")
        return None

    metrics = {
        "ticker": ticker,
        "date": prices.index[-1].date(),
        "close": close,
        "sma": sma,
        "rsi": rsi,
        "diff": (close - sma) / sma * 100.0,       # % vs SMA20
        "move": (close - past) / past * 100.0,     # % over MOVE_LOOKBACK days
    }
    for n in moves:
        base = float(prices.iloc[-(n + 1)])
        metrics[f"d{n}"] = (close - base) / base * 100.0 if base else float("nan")
    return metrics


def plain(text: str) -> str:
    """Strip the Telegram HTML tags so console output stays readable."""
    return re.sub(r"<[^>]+>", "", text)


def stk_width(rows: list, label: str = "STK") -> int:
    """Ticker column width: 6 as before, wider for symbols like RELIANCE.NS."""
    return max(6, len(label) + 1, *(len(m["ticker"]) + 1 for m in rows))


def format_table(rows: list, setup: Setup) -> str:
    """Fixed-width table so the columns line up in a monospace block."""
    # The sharp-move setups already show `move` as their metric column, so only
    # add the D10 column when it would not repeat what is already there.
    show_move = setup.key != "move"
    w = stk_width(rows)

    header = f"{'STK':<{w}}{'CLOSE':>9}{setup.column:>8}{'SMA20':>9}{'RSI':>7}"
    if show_move:
        header += f"{'D10':>8}"
    lines = [header, "-" * len(header)]
    for m in rows:
        line = (
            f"{m['ticker']:<{w}}"
            f"{m['close']:>9.2f}"
            f"{m[setup.key]:>7.1f}%"
            f"{m['sma']:>9.2f}"
            f"{m['rsi']:>7.1f}"
        )
        if show_move:
            line += f"{m['move']:>7.1f}%"
        lines.append(line)
    return "\n".join(lines)


def format_return_table(rows: list) -> str:
    """PREV/LAST/RET table, shared by the two whole-list return reports.

    Rows need `ticker`, `base` (the close measured from), `last` and `ret`.
    """
    w = stk_width(rows)
    header = f"{'STK':<{w}}{'PREV':>9}{'LAST':>9}{'RET':>8}"
    lines = [header, "-" * len(header)]
    for m in rows:
        lines.append(
            f"{m['ticker']:<{w}}"
            f"{m['base']:>9.2f}"
            f"{m['last']:>9.2f}"
            f"{m['ret']:>7.1f}%"
        )
    return "\n".join(lines)


def _mask(value) -> str:
    """Show just enough of an id/token to compare it, without leaking it."""
    value = str(value)
    return f"...{value[-4:]} (len {len(value)})" if len(value) > 4 else "(too short/empty)"


def send_telegram(message: str) -> None:
    """Send one message, logging which chat each copy actually landed in."""
    if not SEND_TELEGRAM:
        print("Telegram delivery is off for this run (SEND_TELEGRAM=0)")
        return

    if TELEGRAM_TOKEN.startswith("YOUR_") or str(TELEGRAM_CHAT_ID).startswith("YOUR_"):
        print("Telegram not configured: TELEGRAM_TOKEN / TELEGRAM_CHAT_ID are placeholders")
        return

    recipients = [c.strip() for c in str(TELEGRAM_CHAT_ID).split(",") if c.strip()]
    if not recipients:
        print("Telegram not configured: TELEGRAM_CHAT_ID is empty")
        return

    if WATCHLIST_LABEL:
        message = f"🗂 <i>{escape(WATCHLIST_LABEL)}</i>\n" + message

    url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
    print(f"Sending to {len(recipients)} recipient(s) with token {_mask(TELEGRAM_TOKEN)}")

    for chat_id in recipients:
        # One bad recipient must not stop the others.
        try:
            resp = requests.post(
                url,
                data={"chat_id": chat_id, "text": message, "parse_mode": "HTML"},
                timeout=15,
            )
            if resp.status_code != 200:
                print(f"  {_mask(chat_id)} FAILED [{resp.status_code}]: {resp.text}")
                continue

            result = resp.json().get("result", {})
            chat = result.get("chat", {})
            print(
                f"  {_mask(chat_id)} OK: message_id={result.get('message_id')} "
                f"-> chat id {_mask(chat.get('id', ''))} "
                f"type={chat.get('type')} "
                f"name={chat.get('first_name') or chat.get('title') or '(none)'}"
            )
        except Exception as exc:
            print(f"  {_mask(chat_id)} FAILED: {exc}")


def _clean(value):
    """Make metrics JSON-safe: dates as ISO strings, NaN as null, floats rounded."""
    if isinstance(value, dict):
        return {k: _clean(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_clean(v) for v in value]
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, float):
        return None if math.isnan(value) or math.isinf(value) else round(value, 6)
    return value


def publish_result(part: str, data: dict) -> None:
    """Post one scanner's numbers to the website, next to the Telegram message.

    `part` names the script (oversold, overbought, bands, fxbands, first5,
    last5), so the two halves of a "both" run land side by side. A failure is
    logged and never stops the run - Telegram delivery does not depend on it.
    """
    if not (RESULTS_URL and RESULTS_SECRET and RUN_ID):
        return
    try:
        resp = requests.post(
            f"{RESULTS_URL}/api/results",
            json={"run_id": RUN_ID, "part": part, "data": _clean(data)},
            headers={"Authorization": f"Bearer {RESULTS_SECRET}"},
            timeout=15,
        )
        if resp.status_code == 200:
            print(f"Results posted to the website ({part}, run {RUN_ID})")
        else:
            print(f"Website rejected the results [{resp.status_code}]: {resp.text[:200]}")
    except Exception as exc:
        print(f"Could not post results to the website: {exc}")


def publish_error(part: str, title: str, message: str) -> None:
    publish_result(part, {"kind": "error", "title": title, "message": message})


def build_parser(description: str) -> argparse.ArgumentParser:
    """The flags every dated scan shares; callers may add their own."""
    parser = argparse.ArgumentParser(description=description)
    parser.add_argument(
        "--as-of",
        metavar="YYYY-MM-DD",
        help="run the scan as it would have run on this date (local only by default)",
    )
    parser.add_argument(
        "--send",
        action="store_true",
        help="send to Telegram even when --as-of is used",
    )
    return parser


def parse_args(description: str):
    return build_parser(description).parse_args()


def run(name: str, setups: list, part: str) -> None:
    """Evaluate every ticker, print each setup's table, send one message.

    `part` is the name the website files these results under.
    """
    args = parse_args(f"{name} scanner")

    as_of = date.fromisoformat(args.as_of) if args.as_of else None
    period = LOOKBACK_HISTORICAL if as_of else LOOKBACK

    metrics = []
    for ticker in TICKERS:
        try:
            m = evaluate(ticker, as_of=as_of, period=period)
            if m is not None:
                metrics.append(m)
        except Exception as exc:
            print(f"Error checking {ticker}: {exc}")

    if not metrics:
        print("No usable data for any ticker.")
        publish_error(part, name, "No usable price data for any ticker. The data source may be down.")
        if NOTIFY_WHEN_EMPTY and not (as_of and not args.send):
            send_telegram(
                f"⚠️ <b>{escape(name)}</b> — no usable price data for any ticker. "
                "The data source may be down."
            )
        return

    bar_date = max(m["date"] for m in metrics)
    header = f"<b>{escape(name)}</b> — bar {bar_date}"
    print(f"\n{name} — bar {bar_date}")

    sections = []
    web_sections = []
    for setup in setups:
        rows = sort_by_tier(
            [m for m in metrics if setup.predicate(m)],
            setup.key,
            descending=setup.descending,
        )
        # Every setup goes to the website, empty ones too, so its tab shows 0.
        web_sections.append({
            "title": plain(setup.title),
            "key": setup.key,
            "rows": [
                {k: m[k] for k in ("ticker", "close", "sma", "rsi", "diff", "move")}
                for m in rows
            ],
        })
        if not rows:
            continue
        table = format_table(rows, setup)
        print(f"\n{plain(setup.title)}")
        print(table)
        sections.append(f"{setup.title}\n<pre>{escape(table)}</pre>")

    publish_result(part, {
        "kind": "screen",
        "title": name,
        "bar": bar_date,
        "scanned": len(metrics),
        "sections": web_sections,
    })

    if sections:
        body = header + "\n\n" + "\n\n".join(sections)
    else:
        print("No matches.")
        if not NOTIFY_WHEN_EMPTY:
            return
        # Say so explicitly - silence is indistinguishable from a broken run.
        body = f"{header}\n\nNo matches — {len(metrics)} tickers scanned."

    if as_of and not args.send:
        print("\n(--as-of set without --send: not sending to Telegram)")
        return

    send_telegram(body)
