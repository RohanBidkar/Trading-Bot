"""
Overbought (short-side) scanner - the mirror of oversold_scanner.py.

Setup C - Above SMA20:
  - Close > SMA20
  - far enough above, scaled by price: >$100 needs 4%, <=$100 needs 3%
  - RSI(14) >= 60

Setup D - Sharp rise:
  - Close is >= 10% above where it was 10 trading days ago

Usage:
    python overbought_scanner.py
    python overbought_scanner.py --as-of 2026-09-01          # print only
    python overbought_scanner.py --as-of 2026-09-01 --send   # and send
"""

from scanner_core import SMA_LEN, Setup, run, tier_threshold

# ---------------- CONFIG ----------------
PCT_RISE_ABOVE_TIER = 4.0    # close > $100 must be this far above SMA20
PCT_RISE_BELOW_TIER = 3.0    # close <= $100 must be this far above SMA20
RSI_OVERBOUGHT = 60
RISE_THRESHOLD = 10.0        # % over the 10-day window
# -----------------------------------------


def above_sma(m: dict) -> bool:
    needed = tier_threshold(m["close"], PCT_RISE_ABOVE_TIER, PCT_RISE_BELOW_TIER)
    return m["close"] > m["sma"] and m["diff"] >= needed and m["rsi"] >= RSI_OVERBOUGHT


def sharp_rise(m: dict) -> bool:
    return m["move"] >= RISE_THRESHOLD


SETUPS = [
    Setup(
        title=(
            f"\U0001F4C8 <b>Above SMA{SMA_LEN}</b> (RSI≥{RSI_OVERBOUGHT}, "
            f"+{PCT_RISE_BELOW_TIER:.0f}%/+{PCT_RISE_ABOVE_TIER:.0f}% over $100)"
        ),
        column="DIFF",
        key="diff",
        predicate=above_sma,
        descending=True,
    ),
    Setup(
        title=f"\U0001F680 <b>Up {RISE_THRESHOLD:.0f}%+ in 10 days</b>",
        column="D10",
        key="move",
        predicate=sharp_rise,
        descending=True,
    ),
]


if __name__ == "__main__":
    run("Overbought scan", SETUPS)
