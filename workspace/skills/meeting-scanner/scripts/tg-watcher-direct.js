"use strict";

/**
 * Pure helpers for the tg-watcher direct-command ("jarvis") path.
 *
 * Extracted into their own module so they can be unit-tested without loading
 * tg-watcher.js, which connects to Telegram at require time. Mirrors the
 * existing tg-watcher-forum-topics.js split.
 */

/**
 * Strip the trigger word from a raw message, preserving the original case of
 * the remaining instruction.
 *
 * The daemon lowercases text for keyword matching, but the instruction itself
 * must reach the agent as the CEO wrote it — a message to be sent verbatim
 * would otherwise arrive mangled.
 *
 * @returns {string} the instruction, or "" if nothing remains
 */
function extractInstruction(rawText, trigger) {
  if (typeof rawText !== "string" || !rawText) return "";
  if (typeof trigger !== "string" || !trigger) return rawText.trim();

  const idx = rawText.toLowerCase().indexOf(trigger.toLowerCase());
  if (idx === -1) return rawText.trim();

  const without = rawText.slice(0, idx) + rawText.slice(idx + trigger.length);
  // Drop leading separators left behind ("jarvis, do X" / "jarvis: do X").
  return without.replace(/^[\s,:\-—]+/, "").trim();
}

/**
 * Bounded FIFO dedup set.
 *
 * NewMessage does not replay on restart, but Telegram can redeliver an update
 * after a reconnect; without this the same instruction runs twice.
 */
function makeSeenSet(max = 500) {
  const seen = new Set();
  return {
    has: (key) => seen.has(key),
    size: () => seen.size,
    remember(key) {
      seen.add(key);
      if (seen.size > max) {
        const excess = seen.size - max;
        let i = 0;
        for (const k of seen) {
          if (i++ >= excess) break;
          seen.delete(k);
        }
      }
    },
  };
}

/**
 * Decide what a resolve/messages response means, so the agent is never asked
 * to guess. Returns one of: "ambiguous" | "not_found" | "empty" | "ok".
 */
function classifyReadResult(response) {
  if (!response || typeof response !== "object") return "not_found";
  if (response.ok === false) {
    const err = String(response.error || "");
    if (/ambiguous/i.test(err)) return "ambiguous";
    return "not_found";
  }
  const messages = Array.isArray(response.messages) ? response.messages : null;
  if (messages && messages.length === 0) return "empty";
  return "ok";
}

module.exports = {
  extractInstruction,
  makeSeenSet,
  classifyReadResult,
};
