"""
Daily SMA20 Oversold Scanner
----------------------------
Strategy (daily timeframe):
  - Close < SMA20
  - Close is far enough below SMA20, scaled by price:
      * price > $100  -> at least 5% below
      * price <= $100 -> at least 4% below
  - RSI(14) <= 40

All calculations use raw (unadjusted) Close, so the SMA/RSI values match what
a standard charting platform displays. See the README for the tradeoff versus
Adjusted Close around ex-dividend dates.

Free stack: yfinance (prices) + Telegram Bot API (alerts).
Run once a day via cron / Task Scheduler / GitHub Actions.
"""

import os

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
# Distance below SMA20 required, tiered by share price. Higher-priced names
# swing more in dollar terms, so they need a deeper pullback to qualify.
PRICE_TIER = 100.0          # dollar cutoff between the two tiers
PCT_DROP_ABOVE_TIER = -5.0  # applies when close > PRICE_TIER
PCT_DROP_BELOW_TIER = -4.0  # applies when close <= PRICE_TIER
RSI_THRESHOLD = 40
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


def check_ticker(ticker: str):
    """Return an alert line if the ticker meets the setup, else None."""
    prices = get_close(ticker)
    if len(prices) < SMA_LEN + RSI_LEN:
        print(f"Skipping {ticker}: only {len(prices)} bars of history")
        return None

    sma = prices.rolling(SMA_LEN).mean()
    rsi = compute_rsi(prices, RSI_LEN)

    close = float(prices.iloc[-1])
    last_sma = float(sma.iloc[-1])
    last_rsi = float(rsi.iloc[-1])

    if pd.isna(last_sma) or pd.isna(last_rsi) or last_sma == 0:
        print(f"Skipping {ticker}: indicators not ready")
        return None

    pct_from_sma = (close - last_sma) / last_sma * 100.0
    required_drop = threshold_for(close)

    if (
        close < last_sma
        and pct_from_sma <= required_drop
        and last_rsi <= RSI_THRESHOLD
    ):
        return (
            f"{ticker}: Close={close:.2f} | "
            f"{pct_from_sma:.1f}% vs SMA20 ({last_sma:.2f}) "
            f"[needs {required_drop:.0f}%] | "
            f"RSI={last_rsi:.1f}"
        )
    return None


def _mask(value: str) -> str:
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
                data={"chat_id": chat_id, "text": message},
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
    hits = []
    for ticker in TICKERS:
        try:
            result = check_ticker(ticker)
            if result:
                hits.append(result)
        except Exception as exc:
            print(f"Error checking {ticker}: {exc}")

    if hits:
        message = "\U0001F4C9 Oversold Setup Alerts:\n" + "\n".join(hits)
        print(message)
        send_telegram(message)
    else:
        print("No matches today.")


if __name__ == "__main__":
    main()
