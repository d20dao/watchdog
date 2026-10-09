// Telegram delivery. The bot token only ever appears in the request URL; it is never logged or returned.

import { LIMITS } from "./config.js";
import { FetchTimeoutError, fetchText } from "./net.js";

const chatValue = value => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);

/**
 * The chat a network's messages go to: its own group when configured, otherwise the default chat.
 * Network scopes map to secrets like TELEGRAM_CHAT_ID_ARC_TESTNET.
 */
export function chatIdFor(env, network) {
  const specific = typeof network === "string" && network !== ""
    ? chatValue(env["TELEGRAM_CHAT_ID_" + network.toUpperCase().replace(/[^A-Z0-9]+/g, "_")])
    : null;
  return specific ?? chatValue(env.TELEGRAM_CHAT_ID);
}

export function notifierConfigured(env) {
  return typeof env.TELEGRAM_BOT_TOKEN === "string" && env.TELEGRAM_BOT_TOKEN.trim() !== "" && chatIdFor(env, null) !== null;
}

const suffixOf = (network) => network.toUpperCase().replace(/[^A-Z0-9]+/g, "_");

/**
 * Where a scope's messages go: {tokenSecret, chatId}, or null when they cannot be delivered. A network in `ownGroups` (a round
 * network) goes only to its own chat, TELEGRAM_CHAT_ID_<NETWORK>, never the default one, with its own bot token
 * TELEGRAM_BOT_TOKEN_<NETWORK> when set and the default token otherwise. Every other scope goes where chatIdFor says, and only
 * while the default notifier is configured. `tokenSecret` is the name of the secret, never its value.
 */
export function routeFor(env, network, ownGroups = new Set()) {
  if (typeof network === "string" && ownGroups.has(network)) {
    const suffix = suffixOf(network);
    const chatId = chatValue(env["TELEGRAM_CHAT_ID_" + suffix]);
    const tokenSecret = chatValue(env["TELEGRAM_BOT_TOKEN_" + suffix]) ? "TELEGRAM_BOT_TOKEN_" + suffix : "TELEGRAM_BOT_TOKEN";
    return chatId && chatValue(env[tokenSecret]) ? { tokenSecret, chatId } : null;
  }
  return notifierConfigured(env) ? { tokenSecret: "TELEGRAM_BOT_TOKEN", chatId: chatIdFor(env, network) } : null;
}

/**
 * Group pending messages (in order) into Telegram-sized texts.
 * Returns [{ids, text}] with at most `maxGroups` groups.
 */
export function groupMessages(messages, maxChars = LIMITS.telegramMaxChars, maxGroups = LIMITS.telegramMaxSendsPerRun) {
  const groups = [];
  let current = null;
  for (const message of messages) {
    const text = message.text.length > maxChars ? message.text.slice(0, maxChars - 3) + "..." : message.text;
    if (current && current.text.length + 2 + text.length <= maxChars) {
      current.ids.push(message.id);
      current.text += "\n\n" + text;
      continue;
    }
    if (groups.length === maxGroups) break;
    current = { ids: [message.id], text };
    groups.push(current);
  }
  return groups;
}

/** Send one message. Resolves to {ok, error} and never throws. */
export async function sendTelegram(env, text, { fetch, timeoutMs = LIMITS.telegramTimeoutMs, chatId = null, tokenSecret = "TELEGRAM_BOT_TOKEN" }) {
  const chat = chatId ?? chatIdFor(env, null);
  let response;
  try {
    response = await fetchText(
      fetch,
      `https://api.telegram.org/bot${env[tokenSecret].trim()}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
      },
      timeoutMs,
      { readBody: false },
    );
  } catch (err) {
    // Never surface the error object: its message could include the request URL (and so the token).
    return { ok: false, error: err instanceof FetchTimeoutError ? "timeout" : "network error" };
  }
  return response.ok ? { ok: true, error: null } : { ok: false, error: `http ${response.status}`, status: response.status };
}
