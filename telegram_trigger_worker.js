/**
 * Telegram -> GitHub Actions trigger (Cloudflare Worker, module syntax).
 *
 * Flow:
 *   Telegram webhook POST -> verify secret header -> command or button
 *   -> POST workflow_dispatch for daily_scan.yml -> reply in Telegram.
 *
 * Commands:
 *   /start                 menu: run now, or pick a past date from a calendar
 *   /scan [YYYY-MM-DD]     oversold (long side), optionally as of a past date
 *   /short [YYYY-MM-DD]    overbought (short side)
 *   /both [YYYY-MM-DD]     run both
 *
 * The /start menu also offers "First 5 days": how every ticker did over the
 * opening sessions of a month, chosen from a month grid.
 *
 * Required environment variables / secrets:
 *   TELEGRAM_TOKEN         bot token from @BotFather (used to reply)
 *   TELEGRAM_SECRET_TOKEN  the secret_token you passed to setWebhook
 *   GITHUB_TOKEN           fine-grained PAT, Actions: read & write
 *   GITHUB_OWNER           e.g. "RohanBidkar"
 *   GITHUB_REPO            e.g. "Trading-Bot"
 *   GITHUB_BRANCH          e.g. "main"
 */

const WORKFLOW_FILE = "daily_scan.yml";

const LABELS = {
  oversold: "📉 Oversold",
  overbought: "📈 Overbought",
  both: "🔀 Both",
  first5: "🗓 First 5 days",
};

// How far back the calendar will navigate. Matches LOOKBACK_HISTORICAL ("2y")
// in scanner_core.py - beyond that there is not enough data to warm up SMA20.
const MAX_MONTHS_BACK = 24;

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// Text commands map to the same three choices as the buttons.
const COMMANDS = {
  "/scan": "oversold",
  "/oversold": "oversold",
  "/short": "overbought",
  "/overbought": "overbought",
  "/both": "both",
};

const MAIN_MENU = {
  inline_keyboard: [
    [
      { text: LABELS.oversold, callback_data: "run:oversold" },
      { text: LABELS.overbought, callback_data: "run:overbought" },
    ],
    [{ text: LABELS.both, callback_data: "run:both" }],
    [{ text: "📅 Pick a date", callback_data: "pick" }],
    [{ text: LABELS.first5, callback_data: "months" }],
  ],
};

const SCAN_CHOICE_MENU = {
  inline_keyboard: [
    [
      { text: LABELS.oversold, callback_data: "cal:oversold" },
      { text: LABELS.overbought, callback_data: "cal:overbought" },
    ],
    [{ text: LABELS.both, callback_data: "cal:both" }],
    [{ text: "« Back", callback_data: "menu" }],
  ],
};

/* ------------------------------ date helpers ------------------------------ */

/** Today in UTC, as YYYY-MM-DD. */
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function isoDate(year, month, day) {
  return `${year}-${pad(month + 1)}-${pad(day)}`;
}

function daysInMonth(year, month) {
  // Day 0 of the next month is the last day of this one.
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/** Monday-first weekday index (0 = Monday) of the 1st of the month. */
function firstWeekdayIndex(year, month) {
  return (new Date(Date.UTC(year, month, 1)).getUTCDay() + 6) % 7;
}

/** Months elapsed from `a` to `b`, both {year, month}. */
function monthsBetween(a, b) {
  return (b.year - a.year) * 12 + (b.month - a.month);
}

/**
 * Validate a user-supplied date. This string ends up in a workflow input, so
 * it is checked strictly here rather than trusted downstream: exact format,
 * a real calendar date (rejects 2026-02-31 via the round-trip), and not in
 * the future.
 */
function parseAsOf(raw) {
  if (!raw) return { ok: true, value: "" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return { ok: false, reason: "Use the format YYYY-MM-DD, e.g. /scan 2026-09-01" };
  }

  const parsed = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) {
    return { ok: false, reason: `${raw} is not a real date.` };
  }
  if (raw > todayISO()) {
    return { ok: false, reason: `${raw} is in the future.` };
  }
  return { ok: true, value: raw };
}

/**
 * Validate a month before it becomes a workflow input. The grid only offers
 * valid ones, but callback data arrives over the wire like any other input,
 * so it is checked here rather than trusted downstream.
 */
function parseMonth(raw) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(raw ?? "")) {
    return { ok: false, reason: "Expected a month in YYYY-MM form." };
  }
  if (raw > todayISO().slice(0, 7)) {
    return { ok: false, reason: `${raw} is in the future.` };
  }
  return { ok: true, value: raw };
}

/**
 * The twelve months of one year as an inline keyboard. Future months render as
 * an inert dot, as do months past the MAX_MONTHS_BACK horizon.
 */
function buildMonthGrid(year) {
  const now = new Date();
  const current = { year: now.getUTCFullYear(), month: now.getUTCMonth() };
  const thisMonth = todayISO().slice(0, 7);
  const blank = { text: " ", callback_data: "noop" };

  // ◀ only if the previous year still has a month inside the horizon (its
  // newest is December); ▶ only while the shown year is behind the current one.
  const navPrev =
    monthsBetween({ year: year - 1, month: 11 }, current) <= MAX_MONTHS_BACK
      ? { text: "◀", callback_data: `yr:${year - 1}` }
      : blank;
  const navNext =
    year < current.year ? { text: "▶", callback_data: `yr:${year + 1}` } : blank;

  const rows = [[navPrev, { text: String(year), callback_data: "noop" }, navNext]];

  let row = [];
  for (let month = 0; month < 12; month++) {
    const iso = `${year}-${pad(month + 1)}`;
    const elapsed = monthsBetween({ year, month }, current);
    const selectable = iso <= thisMonth && elapsed <= MAX_MONTHS_BACK;

    row.push(
      selectable
        ? { text: MONTHS[month].slice(0, 3), callback_data: `mo:${iso}` }
        : { text: "·", callback_data: "noop" },
    );

    if (row.length === 4) {
      rows.push(row);
      row = [];
    }
  }

  rows.push([{ text: "« Back", callback_data: "menu" }]);
  return { inline_keyboard: rows };
}

/**
 * Month grid as an inline keyboard. Weekends and future dates render as an
 * inert dot: markets are shut, and the scan cannot see tomorrow. Holidays are
 * left selectable - the scanner rolls back to the prior session anyway.
 */
function buildCalendar(scan, year, month) {
  const rows = [];
  const now = new Date();
  const current = { year: now.getUTCFullYear(), month: now.getUTCMonth() };
  const shown = { year, month };
  const elapsed = monthsBetween(shown, current);

  const blank = { text: " ", callback_data: "noop" };
  const navPrev =
    elapsed < MAX_MONTHS_BACK
      ? { text: "◀", callback_data: `nav:${scan}:${year}:${month - 1}` }
      : blank;
  const navNext =
    elapsed > 0
      ? { text: "▶", callback_data: `nav:${scan}:${year}:${month + 1}` }
      : blank;

  rows.push([
    navPrev,
    { text: `${MONTHS[month]} ${year}`, callback_data: "noop" },
    navNext,
  ]);
  rows.push(
    ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].map((d) => ({
      text: d,
      callback_data: "noop",
    })),
  );

  const today = todayISO();
  const total = daysInMonth(year, month);
  let week = new Array(firstWeekdayIndex(year, month)).fill(blank);

  for (let day = 1; day <= total; day++) {
    const iso = isoDate(year, month, day);
    const weekday = new Date(`${iso}T00:00:00Z`).getUTCDay();
    const selectable = weekday !== 0 && weekday !== 6 && iso <= today;

    week.push(
      selectable
        ? { text: String(day), callback_data: `day:${scan}:${iso}` }
        : { text: "·", callback_data: "noop" },
    );

    if (week.length === 7) {
      rows.push(week);
      week = [];
    }
  }
  if (week.length) {
    rows.push(week.concat(new Array(7 - week.length).fill(blank)));
  }

  rows.push([{ text: "« Back", callback_data: "pick" }]);
  return { inline_keyboard: rows };
}

/* -------------------------------- telegram -------------------------------- */

async function telegram(env, method, payload) {
  const resp = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    console.error(`Telegram ${method} failed [${resp.status}]:`, await resp.text());
  }
  return resp;
}

function sendMessage(env, chatId, text, extra = {}) {
  return telegram(env, "sendMessage", { chat_id: chatId, text, ...extra });
}

function editMessage(env, chatId, messageId, text, replyMarkup) {
  return telegram(env, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    reply_markup: replyMarkup,
  });
}

/* --------------------------------- github --------------------------------- */

async function triggerWorkflow(env, scan, asOf, month) {
  const url =
    `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}` +
    `/actions/workflows/${WORKFLOW_FILE}/dispatches`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      // GitHub rejects API requests without a User-Agent.
      "User-Agent": "telegram-trigger-worker",
      "Content-Type": "application/json",
    },
    // Every input is always sent (empty = the default); an undeclared or
    // missing input is a 422.
    body: JSON.stringify({
      ref: env.GITHUB_BRANCH,
      inputs: { scan, as_of: asOf ?? "", month: month ?? "" },
    }),
  });

  // workflow_dispatch returns 204 No Content on success.
  if (resp.status === 204) {
    return { ok: true };
  }
  return { ok: false, status: resp.status, detail: await resp.text() };
}

async function runScan(env, chatId, scan, asOf = "", month = "") {
  const result = await triggerWorkflow(env, scan, asOf, month);

  if (result.ok) {
    const when = month ? ` for ${month}` : asOf ? ` as of ${asOf}` : "";
    // The first5 report always has rows, so do not promise silence there.
    const caveat = scan === "first5" ? "" : " (only if something matches)";
    await sendMessage(
      env,
      chatId,
      `✅ ${LABELS[scan]} scan${when} triggered. Results arrive in a minute ` +
        `or two${caveat}.`,
    );
  } else {
    console.error("workflow_dispatch failed:", result.status, result.detail);
    await sendMessage(
      env,
      chatId,
      `❌ Could not trigger the scan (GitHub returned ${result.status}). ` +
        `Check the worker logs and the GITHUB_TOKEN permissions.`,
    );
  }
}

/* ------------------------------- update flow ------------------------------ */

async function handleCallback(env, callback) {
  const data = callback.data ?? "";
  const chatId = callback.message?.chat?.id;
  const messageId = callback.message?.message_id;

  // Clears the button's loading spinner; must be answered either way.
  await telegram(env, "answerCallbackQuery", { callback_query_id: callback.id });

  if (!chatId || data === "noop") return;

  const [action, scan, ...rest] = data.split(":");

  if (action === "menu") {
    await editMessage(env, chatId, messageId, "Which scan would you like to run?", MAIN_MENU);
    return;
  }

  if (action === "pick") {
    await editMessage(env, chatId, messageId, "Scan which side for a past date?", SCAN_CHOICE_MENU);
    return;
  }

  // The first-five report picks a month, not a day, so it has its own grid.
  if (action === "months" || action === "yr") {
    const thisYear = new Date().getUTCFullYear();
    const year = action === "yr" ? Number(scan) : thisYear;
    // The grid only ever emits years in range; a forged one is dropped rather
    // than rendered as a page of dots.
    const oldest = thisYear - Math.ceil(MAX_MONTHS_BACK / 12) - 1;
    if (!Number.isInteger(year) || year < oldest || year > thisYear) return;
    await editMessage(
      env,
      chatId,
      messageId,
      `${LABELS.first5} — pick a month:`,
      buildMonthGrid(year),
    );
    return;
  }

  if (action === "mo") {
    const month = parseMonth(scan);
    if (month.ok) {
      await runScan(env, chatId, "first5", "", month.value);
    }
    return;
  }

  if (!LABELS[scan]) return;

  if (action === "run") {
    await runScan(env, chatId, scan);
    return;
  }

  if (action === "cal" || action === "nav") {
    const now = new Date();
    let year = now.getUTCFullYear();
    let month = now.getUTCMonth();

    if (action === "nav") {
      // Month may be -1 or 12 after navigation; normalise via UTC.
      const target = new Date(Date.UTC(Number(rest[0]), Number(rest[1]), 1));
      year = target.getUTCFullYear();
      month = target.getUTCMonth();
    }

    await editMessage(
      env,
      chatId,
      messageId,
      `${LABELS[scan]} — pick a trading day:`,
      buildCalendar(scan, year, month),
    );
    return;
  }

  if (action === "day") {
    const asOf = parseAsOf(rest[0]);
    if (asOf.ok) {
      await runScan(env, chatId, scan, asOf.value);
    }
  }
}

async function handleMessage(env, message) {
  const chatId = message?.chat?.id;
  const text = (message?.text ?? "").trim();

  // Nothing we can reply to (channel post, sticker, etc.) - just ack.
  if (!chatId) return;

  // Accept "/scan" and group-style "/scan@MyBot", plus an optional date.
  const [rawCommand, ...rest] = text.split(/\s+/);
  const command = rawCommand.split("@")[0].toLowerCase();

  if (command === "/start" || command === "/menu") {
    await sendMessage(env, chatId, "Which scan would you like to run?", {
      reply_markup: MAIN_MENU,
    });
  } else if (COMMANDS[command]) {
    const asOf = parseAsOf(rest[0] ?? "");
    if (!asOf.ok) {
      await sendMessage(env, chatId, `⚠️ ${asOf.reason}`);
    } else {
      await runScan(env, chatId, COMMANDS[command], asOf.value);
    }
  } else {
    await sendMessage(
      env,
      chatId,
      "Send /start to pick a scan, or use /scan (oversold), " +
        "/short (overbought), or /both.\n\n" +
        "Add a date to scan a past session: /scan 2026-09-01\n\n" +
        "The /start menu also has \"First 5 days\" — how every ticker did over " +
        "the opening sessions of a month.",
    );
  }
}

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (!env.TELEGRAM_SECRET_TOKEN || secret !== env.TELEGRAM_SECRET_TOKEN) {
      return new Response("Forbidden", { status: 403 });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("Bad request", { status: 400 });
    }

    // Always return 200 so Telegram does not retry the update.
    try {
      if (update.callback_query) {
        await handleCallback(env, update.callback_query);
      } else {
        await handleMessage(env, update.message ?? update.edited_message);
      }
    } catch (err) {
      console.error("Unhandled error:", err);
    }

    return new Response("OK");
  },
};
