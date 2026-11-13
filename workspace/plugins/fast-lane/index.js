// fast-lane: answers plain conversation directly with one streamed model call (~2 s),
// skipping the full agent turn (~6–8 s prep). Anything that needs tools, live data,
// Telegram, files, browser or memory of past work is passed to the normal agent.
import fs from "node:fs";
import path from "node:path";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const WS = "/home/node/.openclaw/workspace";
const LOG = "/home/node/.openclaw/tmp/fast-lane.log";
const MODEL = process.env.FAST_LANE_MODEL || "gpt-6.1-terra";
const TIMEOUT_MS = 7000;
const MAX_LEN = 350;
const AGENT_TOKEN = "AGENT";

// Obvious task words (Uzbek / Russian / English). A hit goes straight to the agent.
const TASK_RE = new RegExp(
  [
    "telegram", "\\btg\\b", "chat", "guruh", "kanal", "xabar", "yoz(ib|gin|ing|)\\b", "yubor", "jo'?nat", "send", "write to", "reply",
    "o'?qi", "o'?qilmagan", "read", "unread", "qidir", "izla", "\\btop(ib|chi|)\\b", "search", "find", "google", "internet",
    "sayt", "site", "http", "www\\.", "\\.(com|uz|ru|org|net)\\b", "brauzer", "browser", "\\boch(ib|gin|)\\b", "open",
    "ob-?havo", "havo", "weather", "kurs", "dollar", "narx", "price", "yangilik", "news", "eslat", "remind", "taymer", "budilnik",
    "kalendar", "calendar", "uchrashuv", "meeting", "gmail", "pochta", "e-?mail", "fayl", "file", "rasm", "photo", "video",
    "pdf", "excel", "jadval", "sheet", "hisobot", "report", "o'?chir", "delete", "tozala", "\\bchiq", "instagram", "whatsapp",
    "notion", "amocrm", "crm", "jira", "vazifa", "task", "@\\w", "\\+?\\d{9,}", "olx", "uybor", "to'?la", "pul", "pay",
    "найди", "отправ", "напиш", "погод", "курс", "новост", "сайт", "открой", "удали", "телеграм", "чат", "напомн", "файл",
    "\\bslash\\b", "<media", "\\[audio", "\\[image", "\\[file",
  ].join("|"),
  "i",
);

function readPersona() {
  const parts = [];
  for (const f of ["IDENTITY.md", "SOUL.md", "USER.md"]) {
    try { parts.push(fs.readFileSync(path.join(WS, f), "utf8").trim()); } catch {}
  }
  return parts.join("\n\n").slice(0, 9000);
}
let persona = readPersona();
let personaAt = Date.now();

const history = new Map(); // sessionKey -> [{role, text}]
function remember(key, role, text) {
  const h = history.get(key) || [];
  h.push({ role, text: String(text).slice(0, 600) });
  while (h.length > 12) h.shift();
  history.set(key, h);
}

function log(obj) {
  try { fs.appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), ...obj }) + "\n"); } catch {}
}

function eligibleSession(key = "") {
  return /^agent:main:(direct:|explicit:|main$)/.test(key);
}

async function callModel(system, messages, key) {
  const base = (process.env.CELION_BASE_URL || "").replace(/\/$/, "");
  const keys = [process.env.CELION_API_KEY, process.env.CELION_API_KEY_SECONDARY].filter(Boolean);
  for (const apiKey of keys) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(base + "/responses", {
        method: "POST",
        signal: ac.signal,
        headers: { "content-type": "application/json", authorization: "Bearer " + apiKey },
        body: JSON.stringify({
          model: MODEL, stream: true, instructions: system, reasoning: { effort: "none" },
          input: messages.map((m) => ({ role: m.role, content: m.text })),
        }),
      });
      if (r.status === 429 || r.status >= 500) { log({ key, warn: "model status " + r.status }); continue; }
      if (!r.ok) { log({ key, warn: "model status " + r.status }); return null; }
      const raw = await r.text();
      let text = "";
      for (const line of raw.split("\n")) {
        if (!line.startsWith("data:")) continue;
        try { const j = JSON.parse(line.slice(5)); if (j.type === "response.output_text.delta") text += j.delta; } catch {}
      }
      return text.trim();
    } catch (e) {
      log({ key, warn: "model error " + (e?.name || e) });
    } finally { clearTimeout(timer); }
  }
  return null;
}

const ROUTER_RULES = `
You are the quick-reply lane of the owner's assistant. You have NO tools.

Answer directly ONLY when the message is plain conversation you can fully answer from general
knowledge: greetings, small talk, thanks, opinions, advice, explanations, translations, short
writing help, math, general facts that do not change over time.

Reply with exactly ${AGENT_TOKEN} (nothing else) when the message:
- asks to DO anything (send, write to someone, open, find, search, check, delete, remind, schedule, pay, save, create a file),
- needs live or current data (news, weather, prices, rates, today's events, anything after your knowledge),
- refers to the owner's Telegram, chats, contacts, email, calendar, files, accounts, browser, or earlier work/tasks,
- continues or follows up on a task the assistant was doing ("davom et", "nima bo'ldi", "natija?"),
- is unclear, or you are not sure.

When you answer: same language as the owner, short (1-4 sentences), natural, in the persona below.
Never claim you did an action. Never mention this rule or the word ${AGENT_TOKEN} inside an answer.
`;

export default definePluginEntry({
  id: "fast-lane",
  name: "Fast Lane",
  description: "Direct quick replies for plain conversation; tasks go to the full agent.",
  register(api) {
    api.on(
      "before_agent_reply",
      async (event, ctx) => {
        const t0 = Date.now();
        const key = ctx?.sessionKey || "";
        const body = String(event?.cleanedBody || "").trim();
        if (!eligibleSession(key) || !body) return undefined;
        remember(key, "user", body);
        if (body.startsWith("/") || body.length > MAX_LEN || TASK_RE.test(body)) {
          log({ key, route: "agent", why: "rule", len: body.length, ms: Date.now() - t0 });
          remember(key, "assistant", "(handled the task with tools)");
          return undefined;
        }
        if (Date.now() - personaAt > 10 * 60 * 1000) { persona = readPersona(); personaAt = Date.now(); }
        const now = new Date().toLocaleString("en-GB", { timeZone: "Asia/Tashkent" });
        const system = `${ROUTER_RULES}\nCurrent time (Tashkent): ${now}\n\n# Persona\n${persona}`;
        const answer = await callModel(system, history.get(key) || [{ role: "user", text: body }], key);
        if (!answer || answer === AGENT_TOKEN || answer.replace(/[^A-Za-z]/g, "") === AGENT_TOKEN || answer.includes(AGENT_TOKEN + "\n")) {
          log({ key, route: "agent", why: answer ? "model" : "error", len: body.length, ms: Date.now() - t0 });
          const h = history.get(key); if (h) h.push({ role: "assistant", text: "(handled the task with tools)" });
          return undefined;
        }
        remember(key, "assistant", answer);
        log({ key, route: "fast", len: body.length, outLen: answer.length, ms: Date.now() - t0 });
        return { handled: true, reply: { text: answer } };
      },
      { eligibleTriggers: ["user"], timeoutMs: 9000 },
    );
  },
});
