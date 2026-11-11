#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const runtime = process.argv.includes("--runtime");

const GROUP_ID = "-1001234567890";
const SAFE_GROUP_ID = GROUP_ID.replace(/^-/, "");
const CONTAINER = process.env.OPENCLAW_GATEWAY_CONTAINER || "workshop-openclaw-gateway-1";
const CONTAINER_PATH =
  "/home/node/.openclaw/workspace/bin:/home/node/.openclaw/workspace/node_modules/.bin:$PATH";

function pass(message) {
  console.log(`PASS ${message}`);
}

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(rootDir, relativePath), "utf8"));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    encoding: "utf8",
    ...options
  });
  if (result.status !== 0) {
    const detail = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
    fail(`${command} ${args.join(" ")} failed${detail ? `\n${detail}` : ""}`);
  }
  return result.stdout.trim();
}

function runJson(command, args) {
  const stdout = run(command, args);
  try {
    return JSON.parse(stdout);
  } catch {
    fail(`Expected JSON from ${command} ${args.join(" ")}\n${stdout}`);
  }
}

function requireFile(relativePath) {
  assert(existsSync(path.join(rootDir, relativePath)), `Missing ${relativePath}`);
  pass(`${relativePath} exists`);
}

function workspacePathExists(containerWorkspacePath) {
  const prefix = "/home/node/.openclaw/";
  assert(
    containerWorkspacePath.startsWith(prefix),
    `Unexpected workspace path ${containerWorkspacePath}`
  );
  const hostPath = path.join(rootDir, "config", containerWorkspacePath.slice(prefix.length));
  return existsSync(hostPath);
}

function topicAgentId(topicId) {
  return `topic_${SAFE_GROUP_ID}_${topicId}`;
}

function isTopicAgentId(agentId) {
  return new RegExp(`^topic_${SAFE_GROUP_ID}_\\d+$`).test(agentId || "");
}

function assertSkillsVisible(agentId, expectedSkills) {
  const skills = runJson("docker", [
    "exec",
    CONTAINER,
    "sh",
    "-c",
    `PATH=${CONTAINER_PATH} node /app/dist/index.js skills check --agent ${agentId} --json`
  ]);
  const visible = new Set(skills.modelVisible || []);
  const missing = expectedSkills.filter((skill) => !visible.has(skill));
  assert(missing.length === 0, `${agentId} missing model-visible skills: ${missing.join(", ")}`);
  assert(
    (skills.summary?.missingRequirements || 0) === 0,
    `${agentId} has missing skill requirements`
  );
  pass(`${agentId} skill visibility`);
}

function staticChecks() {
  const config = readJson("config/openclaw.json");
  const agents = new Map((config.agents?.list || []).map((agent) => [agent.id, agent]));
  const telegram = config.channels?.telegram;
  const group = telegram?.groups?.[GROUP_ID];
  const topics = group?.topics || {};

  assert(telegram?.enabled === true, "Telegram channel is not enabled");
  assert(telegram.groupPolicy === "allowlist", "Telegram groupPolicy should be allowlist");
  assert(group?.requireMention === true, "Group should be mention-gated");
  assert(topics["1"]?.agentId === topicAgentId("1"), "Topic 1 should route to its dedicated profile");
  assert(topics["4"]?.agentId === topicAgentId("4"), "Topic 4 should route to its dedicated profile");
  for (const [topicId, topic] of Object.entries(topics)) {
    assert(isTopicAgentId(topic.agentId), `Topic ${topicId} should route to a dedicated topic profile`);
  }
  pass("Telegram topic route config");

  assert(agents.has("main"), "Missing main agent");
  for (const topic of Object.values(topics)) {
    const agentId = topic.agentId;
    assert(agents.has(agentId), `Missing agent ${agentId}`);
    assert(workspacePathExists(agents.get(agentId).workspace), `Missing workspace for ${agentId}`);
  }
  pass("Agent and workspace config");

  const generalSkills = new Set(agents.get(topicAgentId("1")).skills || []);
  for (const skill of ["telegram", "telegram-send", "topic-intelligence", "healthcheck", "weather", "taskflow"]) {
    assert(generalSkills.has(skill), `${topicAgentId("1")} missing skill ${skill}`);
  }

  const googleSkills = new Set(agents.get(topicAgentId("4")).skills || []);
  for (const skill of [
    "telegram",
    "telegram-send",
    "topic-intelligence",
    "gws-shared",
    "gws-calendar",
    "gws-gmail",
    "gws-drive"
  ]) {
    assert(googleSkills.has(skill), `${topicAgentId("4")} missing skill ${skill}`);
  }
  pass("Agent skill allowlists");

  const requiredFiles = [
    "workspace/skills/topic-intelligence/SKILL.md",
    "workspace/skills/topic-intelligence/references/daily-audit-workflow.md",
    "workspace/docs/topic-intelligence/README.md",
    "workspace/docs/topic-intelligence/group-onboarding.md",
    "workspace/docs/topic-intelligence/daily-audit-prompt.md",
    "workspace/docs/topic-intelligence/registry.template.json",
    "scripts/test-topic-onboarding.mjs",
    "workspace/skills/meeting-scanner/scripts/tg-watcher-topic-commands.js"
  ];
  for (const topic of Object.values(topics)) {
    const agentId = topic.agentId;
    requiredFiles.push(
      `config/workspaces/${agentId}/AGENTS.md`,
      `config/workspaces/${agentId}/SOUL.md`,
      `config/workspaces/${agentId}/USER.md`
    );
  }
  for (const file of requiredFiles) {
    requireFile(file);
  }

  const ignore = run("git", [
    "check-ignore",
    "-v",
    "workspace/memory/topic-intelligence/registry.json"
  ]);
  assert(ignore.includes("workspace/memory/"), "Topic intelligence runtime memory is not ignored");
  pass("Runtime topic memory is Git-ignored");
}

function runtimeChecks() {
  run("docker", ["compose", "config", "--quiet"]);
  pass("Compose config");

  const runningServices = new Set(
    run("docker", ["compose", "ps", "--services", "--status", "running"])
      .split(/\r?\n/)
      .filter(Boolean)
  );
  for (const service of [
    "openclaw-gateway",
    "openclaw-cli",
    "tg-watcher",
    "cdp-proxy"
  ]) {
    assert(runningServices.has(service), `Service is not running: ${service}`);
  }
  pass("Compose services are running");

  const configStatus = runJson("docker", [
    "exec",
    CONTAINER,
    "sh",
    "-c",
    "node /app/dist/index.js config validate --json"
  ]);
  assert(configStatus.valid === true, "OpenClaw config validation failed");
  pass("OpenClaw config validation");

  const channels = runJson("docker", [
    "exec",
    CONTAINER,
    "sh",
    "-c",
    "node /app/dist/index.js channels status --json"
  ]);
  const telegramAccount = channels.channelAccounts?.telegram?.[0];
  assert(telegramAccount?.configured === true, "Telegram account is not configured");
  assert(telegramAccount?.running === true, "Telegram account is not running");
  assert(telegramAccount?.connected === true, "Telegram account is not connected");
  assert(telegramAccount?.allowUnmentionedGroups === false, "Telegram should be mention-gated");
  pass("Telegram channel status");

  const forum = runJson("docker", [
    "exec",
    CONTAINER,
    "sh",
    "-c",
    [
      "node",
      "-e",
      JSON.stringify(
        "const chat=process.argv[1]; const token=process.env.TELEGRAM_BOT_TOKEN; if(!token){console.log(JSON.stringify({ok:false,error:'missing_token'})); process.exit(1)} fetch('https://api.telegram.org/bot'+token+'/getChat?chat_id='+encodeURIComponent(chat)).then(r=>r.json()).then(j=>console.log(JSON.stringify({ok:j.ok,id:j.result&&j.result.id,title:j.result&&j.result.title,type:j.result&&j.result.type,is_forum:j.result&&j.result.is_forum}))).catch(e=>{console.error(e&&e.stack||String(e));process.exit(1)})"
      ),
      "--",
      GROUP_ID
    ].join(" ")
  ]);
  assert(forum.ok === true, "Telegram getChat failed");
  assert(String(forum.id) === GROUP_ID, "Telegram getChat returned the wrong group");
  assert(forum.is_forum === true, "Telegram group is not forum-enabled");
  pass("Telegram forum getChat");

  run("node", ["scripts/test-topic-onboarding.mjs", "--group", GROUP_ID, "--runtime"]);
  pass("Topic onboarding runtime command");

  assertSkillsVisible(topicAgentId("1"), ["telegram", "telegram-send", "topic-intelligence"]);
  assertSkillsVisible(topicAgentId("4"), [
    "telegram",
    "telegram-send",
    "topic-intelligence",
    "gws-shared",
    "gws-calendar",
    "gws-gmail",
    "gws-drive"
  ]);

  const cron = runJson("docker", [
    "exec",
    CONTAINER,
    "sh",
    "-c",
    "node /app/dist/index.js cron list --json"
  ]);
  const auditJob = (cron.jobs || []).find((item) => item.name === `topic-intelligence-daily--${SAFE_GROUP_ID}`);
  assert(auditJob, "Missing per-group topic-intelligence cron job");
  assert(auditJob.enabled === true, "Per-group topic-intelligence cron job is disabled");
  assert(auditJob.agentId === "main", "Per-group topic-intelligence cron should run as main");
  assert(auditJob.delivery?.channel === "telegram", "Per-group topic-intelligence cron should deliver to Telegram");
  assert(auditJob.delivery?.to === GROUP_ID, "Per-group topic-intelligence cron has wrong Telegram destination");
  const reonboardJob = (cron.jobs || []).find((item) => item.name === `telegram-topic-onboarding--${SAFE_GROUP_ID}`);
  assert(reonboardJob, "Missing per-group topic re-onboarding cron job");
  assert(reonboardJob.enabled === true, "Per-group topic re-onboarding cron job is disabled");
  pass("Topic automation cron jobs");
}

try {
  staticChecks();
  if (runtime) runtimeChecks();
  console.log(runtime ? "Topic profile runtime checks passed." : "Topic profile static checks passed.");
} catch (error) {
  console.error(`FAIL ${error.message}`);
  process.exit(1);
}
