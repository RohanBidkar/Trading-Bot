"""
SMA20 band levels - the whole watchlist at once.

Not a screen: no ticker is filtered out. For every ticker it prints the two
prices that sit BAND_PCT either side of SMA20, so you can see at a glance
where each name would have to trade to reach the band:

    LOW  = SMA20 * (1 - BAND_PCT/100)   the level a pullback would hit
    HIGH = SMA20 * (1 + BAND_PCT/100)   the level a run-up would hit

DIFF is where the close sits today, relative to SMA20: at -BAND_PCT or lower
the low band is already taken out, at +BAND_PCT or higher the high one is.

D22/D15/D5/D1 are the % change over the last 22, 15, 5 and 1 trading sessions
(D1 being the last day's move), and RSI14 is the 14-day RSI.

--forex runs the same table for FOREX_PAIRS instead of the stock watchlist.
Yahoo has no spot gold, so XAUUSD is read from gold futures (GC=F). Crypto
trades every day, so its SMA20 and D-columns count calendar days.

Usage:
    python sma_band_scanner.py
    python sma_band_scanner.py --as-of 2026-09-01          # print only
    python sma_band_scanner.py --as-of 2026-09-01 --send   # and send
    python sma_band_scanner.py --band 3.0                  # a different band
    python sma_band_scanner.py --forex                     # the forex pairs
"""

from datetime import date
from html import escape

from scanner_core import (
    LOOKBACK,
    LOOKBACK_HISTORICAL,
    NOTIFY_WHEN_EMPTY,
    RSI_LEN,
    SMA_LEN,
    TICKERS,
    build_parser,
    evaluate,
    plain,
    publish_error,
    publish_result,
    send_telegram,
    sort_by_tier,
    stk_width,
)

# ---------------- CONFIG ----------------
BAND_PCT = 2.8            # distance either side of SMA20, in percent
MOVE_DAYS = (22, 15, 5, 1)  # trading-day % moves, the first columns after STK
# Display name -> Yahoo Finance symbol, for --forex.
FOREX_PAIRS = {
    "XAUUSD": "GC=F",       # gold futures; Yahoo carries no spot gold
    "ETHUSD": "ETH-USD",
    "EURUSD": "EURUSD=X",
    "GBPUSD": "GBPUSD=X",
    "BTCUSD": "BTC-USD",
}
# Telegram rejects anything over 4096 characters, so a long table goes out in
# several messages rather than failing as one.
MAX_MESSAGE_CHARS = 3500
# -----------------------------------------


def levels(m: dict, band: float) -> dict:
    """The two band prices for one ticker's metrics."""
    return {
        **m,
        "low": m["sma"] * (1 - band / 100.0),
        "high": m["sma"] * (1 + band / 100.0),
    }


def price(value: float, width: int) -> str:
    """A price with as many decimals as its size needs (EURUSD vs BTCUSD)."""
    decimals = 4 if value < 10 else 2 if value < 10000 else 0
    return f"{value:>{width}.{decimals}f}"


def format_table(rows: list, band: float, label: str = "STK") -> str:
    """Fixed-width table so the columns line up in a monospace block."""
    w = stk_width(rows, label)
    header = (
        f"{label:<{w}}"
        + "".join(f"{f'D{n}':>7}" for n in MOVE_DAYS)
        + f"{'DIFF':>7}{f'RSI{RSI_LEN}':>7}{f'SMA{SMA_LEN}':>8}{'CLOSE':>8}"
        f"{f'-{band:.1f}%':>9}{f'+{band:.1f}%':>9}"
    )
    lines = [header, "-" * len(header)]
    for m in rows:
        lines.append(
            f"{m['ticker']:<{w}}"
            + "".join(f"{m[f'd{n}']:>6.1f}%" for n in MOVE_DAYS)
            + f"{m['diff']:>6.1f}%"
            f"{m['rsi']:>7.1f}"
            + price(m["sma"], 8)
            + price(m["close"], 8)
            + price(m["low"], 9)
            + price(m["high"], 9)
        )
    return "\n".join(lines)


def chunk_rows(rows: list, band: float, label: str = "STK") -> list:
    """Split into as many tables as it takes to stay under Telegram's cap."""
    tables, batch = [], []
    for row in rows:
        candidate = batch + [row]
        if batch and len(format_table(candidate, band, label)) > MAX_MESSAGE_CHARS:
            tables.append(format_table(batch, band, label))
            batch = [row]
        else:
            batch = candidate
    if batch:
        tables.append(format_table(batch, band, label))
    return tables


def parse_args():
    parser = build_parser(f"SMA{SMA_LEN} band levels for every ticker")
    parser.add_argument(
        "--band",
        type=float,
        default=BAND_PCT,
        help=f"distance either side of SMA{SMA_LEN}, in percent (default {BAND_PCT})",
    )
    parser.add_argument(
        "--forex",
        action="store_true",
        help=f"scan the forex pairs ({', '.join(FOREX_PAIRS)}) instead of the stocks",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    band = args.band
    if band <= 0:
        raise SystemExit("--band must be greater than 0")

    as_of = date.fromisoformat(args.as_of) if args.as_of else None
    period = LOOKBACK_HISTORICAL if as_of else LOOKBACK
    name = f"{'Forex ' if args.forex else ''}SMA{SMA_LEN} bands ±{band:.1f}%"
    # Display name -> download symbol; stocks are their own symbol.
    symbols = FOREX_PAIRS if args.forex else {t: t for t in TICKERS}
    label = "PAIR" if args.forex else "STK"
    part = "fxbands" if args.forex else "bands"

    rows = []
    for display, symbol in symbols.items():
        try:
            m = evaluate(symbol, as_of=as_of, period=period, moves=MOVE_DAYS)
            if m is not None:
                rows.append(levels({**m, "ticker": display}, band))
        except Exception as exc:
            print(f"Error checking {display}: {exc}")

    if not rows:
        print("No usable data for any ticker.")
        publish_error(part, name, "No usable price data for any ticker. The data source may be down.")
        if NOTIFY_WHEN_EMPTY and not (as_of and not args.send):
            send_telegram(
                f"⚠️ <b>{escape(name)}</b> — no usable price data for any ticker. "
                "The data source may be down."
            )
        return

    # Under-$100 names first, then the rest; within each, most stretched below
    # SMA20 first, so the names nearest the low band are at the top.
    rows = sort_by_tier(rows, "diff")

    bar_date = max(m["date"] for m in rows)
    below = len([m for m in rows if m["diff"] <= -band])
    above = len([m for m in rows if m["diff"] >= band])

    title = f"<b>{escape(name)}</b> — bar {bar_date}"
    subtitle = (
        f"LOW/HIGH are SMA{SMA_LEN} ∓{band:.1f}%. "
        f"{below} at or below the low band, {above} at or above the high, "
        f"of {len(rows)} scanned."
    )

    tables = chunk_rows(rows, band, label)

    columns = ("ticker", "close", "sma", "rsi", "diff", "low", "high", *(f"d{n}" for n in MOVE_DAYS))
    publish_result(part, {
        "kind": "bands",
        "title": name,
        "bar": bar_date,
        "band": band,
        "forex": args.forex,
        "moves": list(MOVE_DAYS),
        "rows": [{k: m[k] for k in columns} for m in rows],
    })

    print(f"\n{plain(title)}\n{subtitle}\n")
    for table in tables:
        print(table)

    if as_of and not args.send:
        print("\n(--as-of set without --send: not sending to Telegram)")
        return

    # One message per table; only the first carries the heading.
    for index, table in enumerate(tables):
        part = f" ({index + 1}/{len(tables)})" if len(tables) > 1 else ""
        head = f"{title}{part}\n{escape(subtitle)}\n\n" if index == 0 else f"{title}{part}\n\n"
        send_telegram(f"{head}<pre>{escape(table)}</pre>")


if __name__ == "__main__":
    main()
