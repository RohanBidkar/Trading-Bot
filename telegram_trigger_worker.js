/**
 * Telegram -> GitHub Actions trigger (Cloudflare Worker, module syntax).
 *
 * Flow:
 *   Telegram webhook POST  ->  verify secret header  ->  /start or /scan
 *   ->  POST workflow_dispatch for daily_scan.yml  ->  reply in Telegram.
 *
 * Required environment variables / secrets:
 *   TELEGRAM_TOKEN         bot token from @BotFather (used to reply)
 *   TELEGRAM_SECRET_TOKEN  the secret_token you passed to setWebhook
 *   GITHUB_TOKEN           fine-grained PAT, Actions: read & write
 *   GITHUB_OWNER           e.g. "your-github-username"
 *   GITHUB_REPO            e.g. "alert-bot"
 *   GITHUB_BRANCH          e.g. "main"
 */

const WORKFLOW_FILE = "daily_scan.yml";

const USAGE_HINT =
  "Send /scan to run the oversold scanner now. (/start does the same thing.)";

async function sendTelegramMessage(env, chatId, text) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });

  if (!resp.ok) {
    console.error(`Telegram sendMessage failed [${resp.status}]:`, await resp.text());
  }
}

async function triggerWorkflow(env) {
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
    body: JSON.stringify({ ref: env.GITHUB_BRANCH }),
  });

  // workflow_dispatch returns 204 No Content on success.
  if (resp.status === 204) {
    return { ok: true };
  }
  return { ok: false, status: resp.status, detail: await resp.text() };
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

    const message = update.message ?? update.edited_message;
    const chatId = message?.chat?.id;
    const text = (message?.text ?? "").trim();

    // Nothing we can reply to (channel post, sticker, etc.) - ack and move on.
    // Always return 200 so Telegram does not retry the update.
    if (!chatId) {
      return new Response("OK");
    }

    // Accept "/scan" and group-style "/scan@MyBot".
    const command = text.split(/\s+/)[0].split("@")[0].toLowerCase();

    if (command === "/start" || command === "/scan") {
      const result = await triggerWorkflow(env);

      if (result.ok) {
        await sendTelegramMessage(
          env,
          chatId,
          "✅ Scan triggered. Results will arrive here in a minute or two " +
            "(only if something matches the setup).",
        );
      } else {
        console.error("workflow_dispatch failed:", result.status, result.detail);
        await sendTelegramMessage(
          env,
          chatId,
          `❌ Could not trigger the scan (GitHub returned ${result.status}). ` +
            "Check the worker logs and the GITHUB_TOKEN permissions.",
        );
      }
    } else {
      await sendTelegramMessage(env, chatId, USAGE_HINT);
    }

    return new Response("OK");
  },
};
