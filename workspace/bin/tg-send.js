#!/usr/bin/env node
"use strict";

const fs = require("fs");

const SEND_PORT = Number(process.env.SEND_PORT || 18792);
const BASE_URL = process.env.TG_WATCHER_URL || `http://127.0.0.1:${SEND_PORT}`;

function usage() {
  return [
    "Usage:",
    "  tg-send list [--limit <n>] [--refresh]",
    "  tg-send resolve --query <visible-name> [--partial] [--refresh]",
    "  tg-send messages --query <visible-name> [--limit <n>] [--partial] [--refresh]",
    "  tg-send messages --peer-id <id> [--limit <n>] [--refresh]",
    "  tg-send send --query <visible-name> --text <message> [--partial] [--refresh] [--allow-ambiguous]",
    "  tg-send send --peer-id <id> --text <message>",
    "  tg-send send --query <visible-name> --text-file <path>",
    "  tg-send digest [--hours 24] [--chats 8] [--per-chat 5] [--include-channels] [--include-bots]",
    "  tg-send remove --peer-ids <id,id,...>            (DRY RUN: shows what would be removed)",
    "  tg-send remove --peer-ids <id,id,...> --confirm  (really leave channels/groups, block+delete bots; max 30)",
    "      add --include-people to also delete private chats with real people (only on owner's side)",
    "",
    "Add --compact to list/resolve/messages for short plain-text output.",
    "Uses the already-running tg-watcher MTProto session.",
  ].join("\n");
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      out._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

async function postJson(path, body) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { ok: false, error: text || `HTTP ${response.status}` };
  }
  if (!response.ok || data.ok === false) {
    const err = new Error(data.error || `HTTP ${response.status}`);
    err.data = data;
    err.status = response.status;
    throw err;
  }
  return data;
}

const MSG_CHARS = 300;

function oneLine(text, max = MSG_CHARS) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function shortTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  // Owner is in Asia/Tashkent (UTC+5).
  return new Date(d.getTime() + 5 * 3600 * 1000).toISOString().slice(5, 16).replace("T", " ");
}

function dialogLine(d) {
  const name = d.visibleName || d.title || d.dialogName || d.peerId;
  const user = d.username ? ` @${d.username}` : "";
  const unread = d.unreadCount ? ` unread=${d.unreadCount}` : "";
  return `${name}${user} [${d.kind || "chat"}] id=${d.peerId}${unread} last=${shortTime(d.lastMessageDate)}`;
}

function messageLine(m) {
  const who = m.direction === "outgoing" ? "me" : m.senderName || "them";
  const media = m.hasMedia && m.kind && m.kind !== "text" ? `[${m.kind}] ` : "";
  return `  ${shortTime(m.timestamp)} ${who}: ${media}${oneLine(m.text || m.transcript || "")}`;
}

function printCompact(command, result) {
  if (command === "list") {
    console.log(`chats ${result.count}/${result.total}`);
    for (const d of result.dialogs || []) console.log(dialogLine(d));
  } else if (command === "resolve") {
    console.log(`matches for "${result.query}": ${result.count}`);
    for (const d of result.matches || []) console.log(dialogLine(d));
  } else if (command === "messages") {
    const d = result.dialog || result.matched || {};
    console.log(dialogLine(d));
    for (const m of result.messages || []) console.log(messageLine(m));
  } else {
    console.log(JSON.stringify(result));
  }
}

async function digest(args) {
  const hours = Number(args.hours || 24);
  const maxChats = Number(args.chats || 8);
  const perChat = Number(args["per-chat"] || 5);
  const includeChannels = args["include-channels"] === true;
  const since = Date.now() - hours * 3600 * 1000;

  const listed = await postJson("/list-dialogs", { limit: 150, refresh: args.refresh === true });
  const candidates = (listed.dialogs || [])
    .filter((d) => includeChannels || !d.isChannel)
    .filter((d) => args["include-bots"] === true || !/bot$/i.test(d.username || ""))
    .filter((d) => (d.unreadCount || 0) > 0 || Date.parse(d.lastMessageDate || 0) >= since)
    .sort((a, b) => (b.unreadCount || 0) - (a.unreadCount || 0)
      || Date.parse(b.lastMessageDate || 0) - Date.parse(a.lastMessageDate || 0))
    .slice(0, maxChats);

  const unreadTotal = candidates.reduce((n, d) => n + (d.unreadCount || 0), 0);
  console.log(`digest: ${candidates.length} active chats in last ${hours}h, unread=${unreadTotal}${includeChannels ? "" : " (channels excluded)"}`);
  if (!candidates.length) return;

  const results = await Promise.all(candidates.map(async (d) => {
    const limit = Math.min(20, Math.max(perChat, d.unreadCount || 0));
    try {
      const r = await postJson("/dialog-messages", { peerId: String(d.peerId), limit });
      return { d, messages: r.messages || [] };
    } catch (e) {
      return { d, error: e.message };
    }
  }));

  for (const { d, messages, error } of results) {
    console.log("");
    console.log(dialogLine(d));
    if (error) {
      console.log(`  (could not read: ${error})`);
      continue;
    }
    // tg-watcher already returns messages oldest-first.
    for (const m of messages) console.log(messageLine(m));
  }
}

function textFromArgs(args) {
  if (args.text !== undefined) return String(args.text);
  if (args["text-file"]) return fs.readFileSync(String(args["text-file"]), "utf8");
  return "";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];

  if (!command || args.help || args.h) {
    console.log(usage());
    process.exit(args.help || args.h ? 0 : 1);
  }

  const out = (result) => (args.compact ? printCompact(command, result) : console.log(JSON.stringify(result, null, 2)));

  if (command === "digest") {
    await digest(args);
    return;
  }

  if (command === "remove") {
    await removeCommand(args);
    return;
  }

  if (command === "resolve") {
    const query = args.query || args.q;
    if (!query) throw new Error("Missing --query");
    const result = await postJson("/resolve-dialog", {
      query,
      exact: args.partial ? false : true,
      refresh: args.refresh === true,
      limit: args.limit ? Number(args.limit) : undefined,
    });
    out(result);
    return;
  }

  if (command === "list") {
    const result = await postJson("/list-dialogs", {
      refresh: args.refresh === true,
      limit: args.limit ? Number(args.limit) : undefined,
    });
    out(result);
    return;
  }

  if (command === "messages") {
    const query = args.query || args.q;
    const peerId = args["peer-id"];
    if (!query && !peerId) throw new Error("Missing --query or --peer-id");
    const result = await postJson("/dialog-messages", {
      query,
      peerId: peerId ? String(peerId) : undefined,
      exact: args.partial ? false : true,
      refresh: args.refresh === true,
      limit: args.limit ? Number(args.limit) : undefined,
    });
    out(result);
    return;
  }

  if (command === "send") {
    const message = textFromArgs(args);
    if (!message.trim()) throw new Error("Missing --text or --text-file");

    if (args["peer-id"]) {
      const result = await postJson("/send-as-ceo", {
        chatId: String(args["peer-id"]),
        message,
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    const query = args.query || args.q;
    if (!query) throw new Error("Missing --query or --peer-id");
    const result = await postJson("/send-to-dialog", {
      query,
      message,
      exact: args.partial ? false : true,
      refresh: args.refresh === true,
      allowAmbiguous: args["allow-ambiguous"] === true,
      limit: args.limit ? Number(args.limit) : undefined,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  throw new Error(`Unknown command: ${command}\n${usage()}`);
}

async function removeCommand(args) {
  const raw = args["peer-ids"] || args["peer-id"];
  if (!raw || raw === true) throw new Error("Missing --peer-ids <id,id,...> (get ids from: tg-send list --limit 300)");
  const peerIds = String(raw).split(/[,\s]+/).filter(Boolean);
  const result = await postJson("/remove-dialogs", {
    peerIds,
    confirm: args.confirm === true,
    includePeople: args["include-people"] === true,
  });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  const payload = err.data || { ok: false, error: err.message };
  console.error(JSON.stringify(payload, null, 2));
  process.exit(1);
});
