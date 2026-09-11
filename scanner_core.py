"""
Shared machinery for the daily scanners.

Holds everything both sides need - price download, indicators, table
formatting, Telegram delivery, CLI parsing - so oversold_scanner.py and
overbought_scanner.py only declare their own thresholds and predicates.

All calculations use raw (unadjusted) Close so the numbers line up with a
standard charting platform. See README for the Adjusted Close tradeoff.
"""

import argparse
import os
import re
from dataclasses import dataclass
from datetime import date
from html import escape
from typing import Callable

import pandas as pd
import requests
import yfinance as yf

# ---------------- SHARED CONFIG ----------------
TICKERS = [
    "SFST", "HBCP", "UNTY", "OBT", "PFIS", "MCBS", "CAC", "CCBG", "JBSS", "SPFI",
    "CBNK", "RBCAA", "SMBC", "THFF", "FCBC", "HWBK", "FBIZ", "CHMG", "MBWM", "GSBC",
    "PKBK", "PLBC", "FRAF", "CCB", "FCAP", "CMTV",
    "BFC", "BANF", "NBN", "BOKF", "BPOP", "CHCO", "ESQ", "EWBC", "FCNCA", "HIFS",
    "PFBC", "QCRH", "RRBI", "UMBF", "WTFC", "DPST", "KRE", "HOV",
]

# Send a "no matches" message too, so a scan never ends in silence. Set to
# 0/false to go back to alert-only delivery (useful for the daily cron).
NOTIFY_WHEN_EMPTY = os.environ.get("NOTIFY_WHEN_EMPTY", "1").strip().lower() not in (
    "0", "false", "no", "off", "",
)

TELEGRAM_TOKEN = os.environ.get("TELEGRAM_TOKEN", "YOUR_BOT_TOKEN_HERE")
# One id, or several separated by commas: "123456789,-1001234567890,@mychannel"
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "YOUR_CHAT_ID_HERE")

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


def get_close(ticker: str, period: str = LOOKBACK) -> pd.Series:
    """Download daily bars and return the raw (unadjusted) Close series.

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


def evaluate(ticker: str, as_of: date = None, period: str = LOOKBACK):
    """Metrics for one ticker as of the last bar on or before `as_of`."""
    prices = get_close(ticker, period)

    if as_of is not None:
        # Truncate to what was knowable that day; a weekend or holiday rolls
        # back to the previous trading session.
        prices = prices[prices.index.date <= as_of]

    needed = max(SMA_LEN + RSI_LEN, MOVE_LOOKBACK + 1)
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

    return {
        "ticker": ticker,
        "date": prices.index[-1].date(),
        "close": close,
        "sma": sma,
        "rsi": rsi,
        "diff": (close - sma) / sma * 100.0,       # % vs SMA20
        "move": (close - past) / past * 100.0,     # % over MOVE_LOOKBACK days
    }


def plain(text: str) -> str:
    """Strip the Telegram HTML tags so console output stays readable."""
    return re.sub(r"<[^>]+>", "", text)


def format_table(rows: list, setup: Setup) -> str:
    """Fixed-width table so the columns line up in a monospace block."""
    # The sharp-move setups already show `move` as their metric column, so only
    # add the D10 column when it would not repeat what is already there.
    show_move = setup.key != "move"

    header = f"{'STK':<6}{'CLOSE':>9}{setup.column:>8}{'SMA20':>9}{'RSI':>7}"
    if show_move:
        header += f"{'D10':>8}"
    lines = [header, "-" * len(header)]
    for m in rows:
        line = (
            f"{m['ticker']:<6}"
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
    header = f"{'STK':<6}{'PREV':>9}{'LAST':>9}{'RET':>8}"
    lines = [header, "-" * len(header)]
    for m in rows:
        lines.append(
            f"{m['ticker']:<6}"
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
    if TELEGRAM_TOKEN.startswith("YOUR_") or str(TELEGRAM_CHAT_ID).startswith("YOUR_"):
        print("Telegram not configured: TELEGRAM_TOKEN / TELEGRAM_CHAT_ID are placeholders")
        return

    recipients = [c.strip() for c in str(TELEGRAM_CHAT_ID).split(",") if c.strip()]
    if not recipients:
        print("Telegram not configured: TELEGRAM_CHAT_ID is empty")
        return

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


def run(name: str, setups: list) -> None:
    """Evaluate every ticker, print each setup's table, send one message."""
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
    for setup in setups:
        rows = [m for m in metrics if setup.predicate(m)]
        rows.sort(key=lambda m: m[setup.key], reverse=setup.descending)
        if not rows:
            continue
        table = format_table(rows, setup)
        print(f"\n{plain(setup.title)}")
        print(table)
        sections.append(f"{setup.title}\n<pre>{escape(table)}</pre>")

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
