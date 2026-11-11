"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const DEFAULT_CONFIG_PATH =
  process.env.OPENCLAW_CONFIG_PATH || path.resolve(__dirname, "../../../../openclaw.json");
const DEFAULT_REGISTRY_ROOT =
  "/home/node/.openclaw/workspace/memory/topic-intelligence/groups";
const DEFAULT_ONBOARD_CMD = "/home/node/.openclaw/workspace/bin/telegram-topic-onboard.mjs";
const DEFAULT_ALLOWLIST_CMD = "/home/node/.openclaw/workspace/bin/topic-agent-allowlists.mjs";
const DEFAULT_OPENCLAW_CMD = "/app/dist/index.js";
const DEFAULT_TZ = "Asia/Tashkent";

const TOPIC_COMMAND_RE =
  /^\/(topic-activate|topic-onboard|topic-routes|topic-audit-now|topic-skills|topic-plugin-suggestions)(?:@[A-Za-z0-9_]+)?(?:\s+.*)?$/i;

function cleanText(value) {
  return String(value || "").trim();
}

function parseTopicCommand(text) {
  const match = cleanText(text).match(TOPIC_COMMAND_RE);
  return match ? match[1].toLowerCase() : null;
}

function valueToString(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "object" && "value" in value) return valueToString(value.value);
  return String(value);
}

function botApiGroupIdFromPeer(peer) {
  const className = cleanText(peer?.className || peer?.constructor?.name);
  if (className === "PeerChannel" && peer?.channelId !== undefined) return `-100${valueToString(peer.channelId)}`;
  if (className === "PeerChat" && peer?.chatId !== undefined) return `-${valueToString(peer.chatId)}`;
  return "";
}

function senderIdFromMessage(message) {
  return (
    valueToString(message?.senderId) ||
    valueToString(message?.fromId?.userId) ||
    valueToString(message?.fromId?.channelId)
  );
}

function topicThreadIdFromMessage(message) {
  const replyTo = message?.replyTo || {};
  return (
    valueToString(replyTo.replyToTopId) ||
    valueToString(replyTo.reply_to_top_id) ||
    valueToString(replyTo.forumTopic ? replyTo.replyToMsgId : "") ||
    valueToString(replyTo.forum_topic ? replyTo.reply_to_msg_id : "")
  );
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function tryReadJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return readJson(filePath);
}

function registryPathForGroup(registryRoot, groupId) {
  return path.join(registryRoot, `${groupId}.json`);
}

function splitIds(value) {
  if (Array.isArray(value)) return value.map(valueToString).map(cleanText).filter(Boolean);
  return cleanText(value).split(/[,\s]+/).map(cleanText).filter(Boolean);
}

function configuredAllowedUserIds(config, groupId, env = process.env) {
  const telegram = config.channels?.telegram || {};
  const group = telegram.groups?.[groupId] || {};
  return new Set([
    ...splitIds(telegram.allowFrom),
    ...splitIds(telegram.groupAllowFrom),
    ...splitIds(group.allowFrom),
    ...splitIds(group.groupAllowFrom),
    ...splitIds(group.admins),
    ...splitIds(env.TELEGRAM_ALLOWED_USER_IDS),
    ...splitIds(env.CEO_TG_ID),
  ]);
}

function authorizeTopicCommand(config, groupId, senderId, env = process.env) {
  const telegram = config.channels?.telegram || {};
  if (telegram.enabled !== true) return { ok: false, reason: "Telegram is not enabled." };
  if (!telegram.groups?.[groupId]) return { ok: false, reason: "This group is not configured for OpenClaw." };

  const allowed = configuredAllowedUserIds(config, groupId, env);
  if (!allowed.has(cleanText(senderId))) {
    return { ok: false, reason: "Only configured OpenClaw owners/admins can run topic commands." };
  }

  return { ok: true };
}

function runProcess(command, args, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill("SIGKILL"); } catch {}
      resolve({ status: null, signal: "SIGKILL", stdout, stderr, timedOut: true });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("close", (status, signal) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr, timedOut: false });
    });
    child.on("error", (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ status: null, signal: null, stdout, stderr: error.message, timedOut: false });
    });
  });
}

async function defaultRunOnboard(groupId) {
  const result = await runProcess("node", [DEFAULT_ONBOARD_CMD, "--group", groupId, "--apply"], {
    timeoutMs: 120000,
  });
  if (result.status !== 0) {
    return { ok: false, error: cleanText(result.stderr) || cleanText(result.stdout) || "topic onboarding failed" };
  }
  try {
    return JSON.parse(result.stdout || "{}");
  } catch {
    return { ok: false, error: "topic onboarding returned invalid JSON" };
  }
}

function buildAuditCronMessage(registry) {
  return [
    "Read /home/node/.openclaw/workspace/docs/topic-intelligence/daily-audit-prompt.md.",
    `Audit Telegram forum group ${cleanText(registry.title) || registry.groupId} (${registry.groupId}) for the last 24 hours.`,
    `Use registry ${registryPathForGroup(DEFAULT_REGISTRY_ROOT, registry.groupId)}.`,
    "When local skills are created or updated, record them under each topic's localSkillsCreated/localSkillsUpdated fields so topic-agent allowlists can be refreshed.",
    "Do not install external plugins; recommend only.",
  ].join("\n");
}

function buildReonboardCronMessage(groupId) {
  const registryPath = registryPathForGroup(DEFAULT_REGISTRY_ROOT, groupId);
  return [
    "Run these Telegram topic maintenance commands exactly once:",
    `node ${DEFAULT_ONBOARD_CMD} --group ${groupId} --apply`,
    `node ${DEFAULT_ALLOWLIST_CMD} --registry ${registryPath} --config ${DEFAULT_CONFIG_PATH} --apply`,
    "",
    "Return the JSON summaries from the commands.",
    "Do not inspect or print secrets.",
    "Do not install external plugins or packages.",
  ].join("\n");
}

async function defaultRefreshAllowlists(groupId) {
  const registryPath = registryPathForGroup(DEFAULT_REGISTRY_ROOT, groupId);
  const result = await runProcess(
    "node",
    [DEFAULT_ALLOWLIST_CMD, "--registry", registryPath, "--config", DEFAULT_CONFIG_PATH, "--apply"],
    { timeoutMs: 30000 }
  );
  if (result.status !== 0) {
    return {
      action: "error",
      error: cleanText(result.stderr) || cleanText(result.stdout) || "topic agent allowlist refresh failed",
    };
  }
  try {
    const parsed = JSON.parse(result.stdout || "{}");
    return {
      action: parsed.changed ? "update" : "exists",
      updatedAgents: parsed.updatedAgents || [],
    };
  } catch {
    return { action: "error", error: "topic agent allowlist refresh returned invalid JSON" };
  }
}

async function addCronIfMissing(spec, existingJobs) {
  const existing = existingJobs.find((job) => cleanText(job.name) === spec.name);
  const args = [
    DEFAULT_OPENCLAW_CMD,
    "cron",
    existing ? "edit" : "add",
  ];
  if (existing) {
    args.push(cleanText(existing.id) || spec.name, "--enable");
  }
  args.push(
    "--name",
    spec.name,
    "--description",
    spec.description,
    "--agent",
    spec.agent,
    "--session",
    "isolated",
    "--session-key",
    spec.sessionKey,
    "--cron",
    spec.cron,
    "--tz",
    spec.tz,
    "--message",
    spec.message,
    "--expect-final",
    "--timeout",
    String(spec.timeoutMs)
  );
  if (!existing) args.push("--json");
  if (spec.delivery) {
    args.push("--announce", "--channel", spec.delivery.channel, "--to", spec.delivery.to, "--best-effort-deliver");
  } else {
    args.push("--no-deliver");
  }
  if (spec.tools?.length) {
    args.push("--tools", spec.tools.join(","));
  } else if (existing) {
    args.push("--clear-tools");
  }
  const result = await runProcess("node", args, { timeoutMs: 30000 });
  if (result.status !== 0) {
    return { name: spec.name, action: "error", error: cleanText(result.stderr) || cleanText(result.stdout) || "cron add/edit failed" };
  }
  return { name: spec.name, action: existing ? "update" : "add" };
}

async function defaultRunActivate(groupId) {
  const onboarding = await defaultRunOnboard(groupId);
  if (!onboarding.ok) return { ok: false, error: onboarding.error || "topic onboarding failed", onboarding };

  const registry = tryReadJson(registryPathForGroup(DEFAULT_REGISTRY_ROOT, groupId));
  if (!registry) return { ok: false, error: "topic onboarding did not create a registry", onboarding };

  const safeId = safeGroupId(groupId);
  const allowlists = await defaultRefreshAllowlists(groupId);
  const existingJobs = await defaultListCronJobs();
  const crons = [];
  crons.push(
    await addCronIfMissing(
      {
        name: `topic-intelligence-daily--${safeId}`,
        description: `Daily Telegram topic intelligence audit for ${cleanText(registry.title) || groupId}`,
        agent: "main",
        sessionKey: `agent:main:cron:topic-intelligence-daily:${safeId}`,
        cron: "30 9 * * *",
        tz: DEFAULT_TZ,
        message: buildAuditCronMessage(registry),
        timeoutMs: 60000,
        delivery: { channel: "telegram", to: groupId },
      },
      existingJobs
    )
  );
  crons.push(
    await addCronIfMissing(
      {
        name: `telegram-topic-onboarding--${safeId}`,
        description: `Refresh Telegram forum topic routes for ${cleanText(registry.title) || groupId}`,
        agent: "main",
        sessionKey: `agent:main:cron:telegram-topic-onboarding:${safeId}`,
        cron: "0 */6 * * *",
        tz: DEFAULT_TZ,
        message: buildReonboardCronMessage(groupId),
        timeoutMs: 120000,
        tools: ["exec"],
      },
      existingJobs
    )
  );

  const cronCleanup = await disableLegacyAuditCronIfRedundant(await defaultListCronJobs(), groupId);

  return { ok: true, onboarding, allowlists, crons, cronCleanup };
}

async function defaultListCronJobs() {
  const result = await runProcess("node", [DEFAULT_OPENCLAW_CMD, "cron", "list", "--json"], {
    timeoutMs: 30000,
  });
  if (result.status !== 0) return [];
  try {
    return JSON.parse(result.stdout || "{}").jobs || [];
  } catch {
    return [];
  }
}

async function defaultRunCronJob(name) {
  const result = await runProcess("node", [DEFAULT_OPENCLAW_CMD, "cron", "run", name, "--json"], {
    timeoutMs: 30000,
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function disableLegacyAuditCronIfRedundant(existingJobs, groupId, deps = {}) {
  const jobs = existingJobs || [];
  const safeId = safeGroupId(groupId);
  const preferred = `topic-intelligence-daily--${safeId}`;
  const hasPreferred = jobs.some((job) => job.name === preferred && job.enabled !== false);
  const legacy = jobs.find((job) => job.name === "topic-intelligence-daily" && job.enabled !== false);
  if (!hasPreferred || !legacy) {
    return { name: "topic-intelligence-daily", action: "not-needed" };
  }

  const run = deps.runProcess || runProcess;
  const result = await run(
    "node",
    [DEFAULT_OPENCLAW_CMD, "cron", "edit", cleanText(legacy.id) || legacy.name, "--disable"],
    { timeoutMs: 30000 }
  );
  if (result.status !== 0) {
    return {
      name: "topic-intelligence-daily",
      action: "error",
      error: cleanText(result.stderr) || cleanText(result.stdout) || "legacy cron disable failed",
    };
  }
  return { name: "topic-intelligence-daily", action: "disable" };
}

function safeGroupId(groupId) {
  return cleanText(groupId).replace(/^-/, "").replace(/[^A-Za-z0-9_-]/g, "-");
}

function topicEntries(config, registry, groupId) {
  const configTopics = config.channels?.telegram?.groups?.[groupId]?.topics || {};
  const registryTopics = registry?.topics || {};
  const ids = [...new Set([...Object.keys(configTopics), ...Object.keys(registryTopics)])].sort((a, b) => Number(a) - Number(b));
  return ids.map((id) => ({
    id,
    title: cleanText(registryTopics[id]?.title) || `Topic ${id}`,
    status: cleanText(registryTopics[id]?.status) || "configured",
    agentId: cleanText(configTopics[id]?.agentId || registryTopics[id]?.agentId) || "unassigned",
    routingMode: cleanText(registryTopics[id]?.routingMode) || "configured",
    skills: Array.isArray(registryTopics[id]?.skills) ? registryTopics[id].skills : [],
    localSkillsCreated: Array.isArray(registryTopics[id]?.localSkillsCreated) ? registryTopics[id].localSkillsCreated : [],
    localSkillsUpdated: Array.isArray(registryTopics[id]?.localSkillsUpdated) ? registryTopics[id].localSkillsUpdated : [],
    pluginRecommendations: Array.isArray(registryTopics[id]?.pluginRecommendations) ? registryTopics[id].pluginRecommendations : [],
  }));
}

function limitLines(lines, limit = 20) {
  if (lines.length <= limit) return lines;
  return [...lines.slice(0, limit), `...and ${lines.length - limit} more.`];
}

function formatOnboardSummary(result) {
  if (!result?.ok) return `Topic onboarding failed: ${cleanText(result?.error) || "unknown error"}`;
  const added = (result.routes || []).filter((route) => route.action === "add").length;
  const updated = (result.routes || []).filter((route) => route.action === "update").length;
  const preserved = (result.routes || []).filter((route) => route.action === "preserve").length;
  return [
    "Topic onboarding complete.",
    `Group: ${result.title || result.groupId}`,
    `Discovered topics: ${result.topicsDiscovered}`,
    `Registry topics: ${result.registryTopicCount ?? result.topicsDiscovered}`,
    `Config changed: ${result.configChanged ? "yes" : "no"}`,
    `Routes: ${added} added, ${updated} updated, ${preserved} preserved.`,
  ].join("\n");
}

function formatActivateSummary(result) {
  if (!result?.ok) return `Topic activation failed: ${cleanText(result?.error) || "unknown error"}`;
  const onboarding = result.onboarding || {};
  const added = (onboarding.routes || []).filter((route) => route.action === "add").length;
  const updated = (onboarding.routes || []).filter((route) => route.action === "update").length;
  const preserved = (onboarding.routes || []).filter((route) => route.action === "preserve").length;
  const createdProfiles = (onboarding.routes || []).filter((route) => /^topic_\d+_\d+$/.test(cleanText(route.agentId))).length;
  const cronSummary = (result.crons || [])
    .map((cron) => `${cron.name}: ${cron.action}`)
    .join(", ");
  const allowlistAction = cleanText(result.allowlists?.action);
  const cleanup = result.cronCleanup?.action === "disable"
    ? " Legacy topic-intelligence-daily disabled."
    : "";
  return [
    "Topic activation complete.",
    `Group: ${onboarding.title || onboarding.groupId}`,
    `Discovered topics: ${onboarding.topicsDiscovered}`,
    `Dedicated profiles: ${createdProfiles}`,
    `Routes: ${added} added, ${updated} updated, ${preserved} preserved.`,
    `Skill allowlists: ${allowlistAction || "no changes"}.`,
    `Automation: ${cronSummary || "no cron changes"}.${cleanup}`,
  ].join("\n");
}

function formatRoutes(config, registry, groupId) {
  const entries = topicEntries(config, registry, groupId);
  if (!entries.length) return "No topic routes are configured yet. Run /topic-onboard first.";
  const title = registry?.title || groupId;
  return [
    `Topic routes for ${title}:`,
    ...limitLines(entries.map((topic) => `- ${topic.id} ${topic.title}: ${topic.agentId} (${topic.status}, ${topic.routingMode})`)),
  ].join("\n");
}

function recordName(record) {
  return cleanText(typeof record === "string" ? record : record?.name || record?.skillName);
}

function formatSkills(config, registry, groupId) {
  if (!registry) return "No topic registry exists yet. Run /topic-onboard first.";
  const entries = topicEntries(config, registry, groupId);
  const lines = [];
  for (const topic of entries) {
    const local = [...topic.localSkillsCreated, ...topic.localSkillsUpdated].map(recordName).filter(Boolean);
    const skills = [...new Set([...topic.skills, ...local])].filter(Boolean);
    lines.push(`- ${topic.id} ${topic.title}: ${skills.length ? skills.join(", ") : "no topic skills recorded"}`);
  }
  return [`Topic skills for ${registry.title || groupId}:`, ...limitLines(lines)].join("\n");
}

function formatPluginSuggestions(registry) {
  if (!registry) return "No topic registry exists yet. Run /topic-onboard first.";
  const suggestions = [];
  for (const suggestion of registry.pluginSuggestions || []) {
    suggestions.push(`- ${cleanText(suggestion.candidate || suggestion.name || suggestion)}`);
  }
  for (const [topicId, topic] of Object.entries(registry.topics || {})) {
    for (const recommendation of topic.pluginRecommendations || []) {
      const candidate = cleanText(recommendation.candidate || recommendation.name || "External integration");
      const workflow = cleanText(recommendation.workflow || recommendation.capability);
      suggestions.push(`- ${topicId} ${topic.title || "Topic"}: ${candidate}${workflow ? ` (${workflow})` : ""}`);
    }
  }
  if (!suggestions.length) {
    return "No plugin suggestions are recorded. External installs remain approval-only.";
  }
  return ["Plugin suggestions:", ...limitLines(suggestions)].join("\n");
}

async function runAuditNow(groupId, deps = {}) {
  const listCronJobs = deps.listCronJobs || defaultListCronJobs;
  const runCronJob = deps.runCronJob || defaultRunCronJob;
  const safeId = safeGroupId(groupId);
  const jobs = await listCronJobs();
  const preferred = `topic-intelligence-daily--${safeId}`;
  const legacy = "topic-intelligence-daily";
  const job = jobs.find((item) => item.name === preferred) || jobs.find((item) => item.name === legacy);
  if (!job) {
    return "No topic audit cron job is installed yet. Install it with install-topic-intelligence-cron.mjs.";
  }
  const result = await runCronJob(job.name);
  if (!result.ok) return `Topic audit could not be started: ${cleanText(result.stderr) || "cron run failed"}`;
  return `Topic audit started: ${job.name}`;
}

async function executeTopicCommand(context, deps = {}) {
  const command = context.command || parseTopicCommand(context.text);
  if (!command) return null;

  const configPath = deps.configPath || DEFAULT_CONFIG_PATH;
  const registryRoot = deps.registryRoot || DEFAULT_REGISTRY_ROOT;
  const config = deps.config || readJson(configPath);
  const auth = authorizeTopicCommand(config, context.groupId, context.senderId, deps.env || process.env);
  if (!auth.ok) return { ok: false, text: auth.reason };

  const registry = deps.registry !== undefined
    ? deps.registry
    : tryReadJson(registryPathForGroup(registryRoot, context.groupId));

  if (command === "topic-onboard") {
    const runOnboard = deps.runOnboard || defaultRunOnboard;
    return { ok: true, text: formatOnboardSummary(await runOnboard(context.groupId)) };
  }

  if (command === "topic-activate") {
    const runActivate = deps.runActivate || defaultRunActivate;
    return { ok: true, text: formatActivateSummary(await runActivate(context.groupId)) };
  }

  if (command === "topic-routes") {
    return { ok: true, text: formatRoutes(config, registry, context.groupId) };
  }

  if (command === "topic-audit-now") {
    return { ok: true, text: await runAuditNow(context.groupId, deps) };
  }

  if (command === "topic-skills") {
    return { ok: true, text: formatSkills(config, registry, context.groupId) };
  }

  if (command === "topic-plugin-suggestions") {
    return { ok: true, text: formatPluginSuggestions(registry) };
  }

  return null;
}

module.exports = {
  authorizeTopicCommand,
  botApiGroupIdFromPeer,
  disableLegacyAuditCronIfRedundant,
  executeTopicCommand,
  formatActivateSummary,
  formatOnboardSummary,
  formatPluginSuggestions,
  formatRoutes,
  formatSkills,
  parseTopicCommand,
  registryPathForGroup,
  runAuditNow,
  senderIdFromMessage,
  topicThreadIdFromMessage,
};
