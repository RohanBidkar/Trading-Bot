"""
Daily Oversold Scanner
----------------------
Two independent setups, evaluated on the most recent completed daily bar:

  A. Below SMA20
       - Close < SMA20
       - Close far enough below SMA20, scaled by price:
           * price > $100  -> at least 5% below
           * price <= $100 -> at least 4% below
       - RSI(14) <= 40

  B. Sharp drop
       - Close is >= 10% below where it was 10 trading days ago

A ticker matching either setup is reported; one matching both appears in both
tables. All calculations use raw (unadjusted) Close so the numbers line up with
a standard charting platform.

Free stack: yfinance (prices) + Telegram Bot API (alerts).
"""

import os
from html import escape

import pandas as pd
import requests
import yfinance as yf

# ---------------- CONFIG ----------------
TICKERS = [
    "SFST", "HBCP", "UNTY", "OBT", "PFIS", "MCBS", "CAC", "CCBG", "JBSS", "SPFI",
    "CBNK", "RBCAA", "SMBC", "THFF", "FCBC", "HWBK", "FBIZ", "CHMG", "MBWM", "GSBC",
    "PKBK", "PLBC", "FRAF", "CCB", "FCAP", "CMTV",
    "BFC", "BANF", "NBN", "BOKF", "BPOP", "CHCO", "ESQ", "EWBC", "FCNCA", "HIFS",
    "PFBC", "QCRH", "RRBI", "UMBF", "WTFC", "DPST", "KRE", "HOV",
]

TELEGRAM_TOKEN = os.environ.get("TELEGRAM_TOKEN", "YOUR_BOT_TOKEN_HERE")
# One id, or several separated by commas: "123456789,-1001234567890,@mychannel"
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "YOUR_CHAT_ID_HERE")

SMA_LEN = 20
RSI_LEN = 14

# Setup A: distance below SMA20, tiered by share price.
PRICE_TIER = 100.0          # dollar cutoff between the two tiers
PCT_DROP_ABOVE_TIER = -5.0  # applies when close > PRICE_TIER
PCT_DROP_BELOW_TIER = -4.0  # applies when close <= PRICE_TIER
RSI_THRESHOLD = 40

# Setup B: sharp recent drop, independent of the SMA.
DROP_LOOKBACK = 10          # trading days to look back
DROP_THRESHOLD = -10.0      # percent change over that window

LOOKBACK = "6mo"
# -----------------------------------------


def threshold_for(close: float) -> float:
    """Required % distance below SMA20 for a given share price."""
    return PCT_DROP_ABOVE_TIER if close > PRICE_TIER else PCT_DROP_BELOW_TIER


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


def get_close(ticker: str) -> pd.Series:
    """Download daily bars and return the raw (unadjusted) Close series.

    auto_adjust=False is essential here: newer yfinance defaults it to True,
    which back-adjusts the 'Close' column for dividends and splits. We want the
    untouched printed close, so the indicators line up with a charting
    platform, which means asking for unadjusted data explicitly.
    """
    df = yf.download(
        ticker,
        period=LOOKBACK,
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


def evaluate(ticker: str):
    """Return a dict of the metrics for one ticker, or None if unusable."""
    prices = get_close(ticker)

    needed = max(SMA_LEN + RSI_LEN, DROP_LOOKBACK + 1)
    if len(prices) < needed:
        print(f"Skipping {ticker}: only {len(prices)} bars of history")
        return None

    close = float(prices.iloc[-1])
    sma = float(prices.rolling(SMA_LEN).mean().iloc[-1])
    rsi = float(compute_rsi(prices, RSI_LEN).iloc[-1])
    past = float(prices.iloc[-(DROP_LOOKBACK + 1)])

    if pd.isna(sma) or pd.isna(rsi) or sma == 0 or past == 0:
        print(f"Skipping {ticker}: indicators not ready")
        return None

    return {
        "ticker": ticker,
        "close": close,
        "sma": sma,
        "rsi": rsi,
        "diff": (close - sma) / sma * 100.0,      # % vs SMA20
        "drop": (close - past) / past * 100.0,    # % over DROP_LOOKBACK days
        "needs": threshold_for(close),
    }


def is_below_sma_setup(m: dict) -> bool:
    """Setup A: stretched below SMA20 with weak momentum."""
    return m["close"] < m["sma"] and m["diff"] <= m["needs"] and m["rsi"] <= RSI_THRESHOLD


def is_sharp_drop_setup(m: dict) -> bool:
    """Setup B: down hard over the recent window, regardless of the SMA."""
    return m["drop"] <= DROP_THRESHOLD


def format_table(rows: list, second_col: str) -> str:
    """Fixed-width table. `second_col` is 'DIFF' (vs SMA20) or 'D10' (drop)."""
    key = "diff" if second_col == "DIFF" else "drop"
    header = f"{'STK':<6}{'CLOSE':>9}{second_col:>8}{'SMA20':>9}{'RSI':>7}"
    lines = [header, "-" * len(header)]
    for m in rows:
        lines.append(
            f"{m['ticker']:<6}"
            f"{m['close']:>9.2f}"
            f"{m[key]:>7.1f}%"
            f"{m['sma']:>9.2f}"
            f"{m['rsi']:>7.1f}"
        )
    return "\n".join(lines)


def build_message(below_sma: list, sharp_drop: list) -> str:
    """Telegram HTML. <pre> keeps the columns aligned in a monospace font."""
    parts = []
    if below_sma:
        parts.append(
            f"\U0001F4C9 <b>Below SMA{SMA_LEN}</b> "
            f"(RSI≤{RSI_THRESHOLD}, {abs(PCT_DROP_BELOW_TIER):.0f}% "
            f"/ {abs(PCT_DROP_ABOVE_TIER):.0f}% over ${PRICE_TIER:.0f})\n"
            f"<pre>{escape(format_table(below_sma, 'DIFF'))}</pre>"
        )
    if sharp_drop:
        parts.append(
            f"⚡ <b>Down {abs(DROP_THRESHOLD):.0f}%+ in {DROP_LOOKBACK} days</b>\n"
            f"<pre>{escape(format_table(sharp_drop, 'D10'))}</pre>"
        )
    return "\n\n".join(parts)


def _mask(value) -> str:
    """Show just enough of an id/token to compare it, without leaking it."""
    value = str(value)
    return f"...{value[-4:]} (len {len(value)})" if len(value) > 4 else "(too short/empty)"


def send_telegram(message: str) -> None:
    """Send the alert and log where it actually landed.

    Telegram answering 200 does not mean the message reached the chat you
    expected - it means it reached the chat matching TELEGRAM_CHAT_ID. Logging
    the chat id it echoes back is what makes a misconfigured id visible.
    """
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


def main() -> None:
    below_sma, sharp_drop = [], []

    for ticker in TICKERS:
        try:
            metrics = evaluate(ticker)
            if metrics is None:
                continue
            if is_below_sma_setup(metrics):
                below_sma.append(metrics)
            if is_sharp_drop_setup(metrics):
                sharp_drop.append(metrics)
        except Exception as exc:
            print(f"Error checking {ticker}: {exc}")

    # Most stretched first in each table.
    below_sma.sort(key=lambda m: m["diff"])
    sharp_drop.sort(key=lambda m: m["drop"])

    if not below_sma and not sharp_drop:
        print("No matches today.")
        return

    if below_sma:
        print(f"\nBelow SMA{SMA_LEN}:")
        print(format_table(below_sma, "DIFF"))
    if sharp_drop:
        print(f"\nDown {abs(DROP_THRESHOLD):.0f}%+ in {DROP_LOOKBACK} days:")
        print(format_table(sharp_drop, "D10"))

    send_telegram(build_message(below_sma, sharp_drop))


if __name__ == "__main__":
    main()
