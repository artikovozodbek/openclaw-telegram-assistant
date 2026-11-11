#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");

const DEFAULT_REGISTRY_ROOT = path.join(
  rootDir,
  "workspace",
  "memory",
  "topic-intelligence",
  "groups"
);
const DEFAULT_CONTAINER_REGISTRY_ROOT =
  "/home/node/.openclaw/workspace/memory/topic-intelligence/groups";
const DEFAULT_CONTAINER = process.env.OPENCLAW_GATEWAY_CONTAINER || "workshop-openclaw-gateway-1";
const DEFAULT_CRON = "30 9 * * *";
const DEFAULT_TZ = "Asia/Tashkent";
const DEFAULT_AGENT = "main";
const DEFAULT_TIMEOUT_MS = 60000;

function usage() {
  return [
    "Usage:",
    "  node scripts/install-topic-intelligence-cron.mjs --all --dry-run",
    "  node scripts/install-topic-intelligence-cron.mjs --all --apply",
    "  node scripts/install-topic-intelligence-cron.mjs --group -100... --apply",
    "",
    "Options:",
    "  --registry-root <path>            Host registry groups dir",
    "  --container-registry-root <path>  Container registry groups dir",
    "  --container <name>                OpenClaw gateway/CLI container",
    "  --cron <expr>                     Cron expression",
    "  --tz <timezone>                   Cron timezone",
    "  --agent <id>                      Agent id",
  ].join("\n");
}

export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

function cleanText(value) {
  return String(value || "").trim();
}

function fail(message) {
  throw new Error(message);
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

export function safeGroupId(groupId) {
  const value = cleanText(groupId);
  if (!/^-100\d+$/.test(value)) fail(`Invalid Telegram group id: ${groupId}`);
  return value.replace(/^-/, "").replace(/[^A-Za-z0-9_-]/g, "-");
}

function registryFileForGroup(registryRoot, groupId) {
  return path.join(registryRoot, `${groupId}.json`);
}

export function readGroupRegistries(registryRoot, { groupId = "", all = false } = {}) {
  const root = path.resolve(registryRoot);
  if (groupId) {
    const filePath = registryFileForGroup(root, groupId);
    if (!existsSync(filePath)) fail(`Missing onboarded group registry: ${filePath}`);
    const registry = readJson(filePath);
    return [{ ...registry, registryPath: filePath }];
  }

  if (!all) fail("Choose --all or --group -100...");
  if (!existsSync(root)) return [];

  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && entry.name !== "index.json")
    .map((entry) => {
      const filePath = path.join(root, entry.name);
      return { ...readJson(filePath), registryPath: filePath };
    })
    .filter((registry) => registry.onboardingStatus === "active");
}

export function buildCronMessage(registry, containerRegistryRoot = DEFAULT_CONTAINER_REGISTRY_ROOT) {
  const title = cleanText(registry.title) || "Telegram forum group";
  const registryPath = `${containerRegistryRoot.replace(/\/+$/, "")}/${registry.groupId}.json`;
  return [
    "Read /home/node/.openclaw/workspace/docs/topic-intelligence/daily-audit-prompt.md.",
    `Audit Telegram forum group ${title} (${registry.groupId}) for the last 24 hours.`,
    `Use registry ${registryPath}.`,
    "When local skills are created or updated, record them under each topic's localSkillsCreated/localSkillsUpdated fields so topic-agent allowlists can be refreshed.",
    "Do not install external plugins; recommend only.",
  ].join("\n");
}

export function buildCronSpec(registry, options = {}) {
  const safeId = safeGroupId(registry.groupId);
  const name = `topic-intelligence-daily--${safeId}`;
  const agent = options.agent || DEFAULT_AGENT;
  return {
    groupId: registry.groupId,
    title: cleanText(registry.title),
    name,
    description: `Daily Telegram topic intelligence audit for ${cleanText(registry.title) || registry.groupId}`,
    agent,
    sessionKey: `agent:${agent}:cron:topic-intelligence-daily:${safeId}`,
    cron: options.cron || DEFAULT_CRON,
    tz: options.tz || DEFAULT_TZ,
    message: buildCronMessage(registry, options.containerRegistryRoot),
    channel: "telegram",
    to: registry.groupId,
    timeoutMs: Number(options.timeoutMs || DEFAULT_TIMEOUT_MS),
  };
}

export function planCronInstalls(registries, existingJobs = [], options = {}) {
  const existingNames = new Set((existingJobs || []).map((job) => cleanText(job.name)).filter(Boolean));
  return registries.map((registry) => {
    const spec = buildCronSpec(registry, options);
    const exists = existingNames.has(spec.name);
    return {
      ...spec,
      action: exists ? "exists" : "add",
      wouldChange: !exists,
    };
  });
}

export function listCronJobs(container = DEFAULT_CONTAINER) {
  const result = spawnSync("docker", ["exec", container, "node", "/app/dist/index.js", "cron", "list", "--json"], {
    encoding: "utf8",
    timeout: 30000,
  });
  if (result.status !== 0) {
    fail(cleanText(result.stderr) || cleanText(result.stdout) || `docker exec ${container} cron list failed`);
  }
  const parsed = JSON.parse(result.stdout || "{}");
  return parsed.jobs || [];
}

export function addCronJob(spec, container = DEFAULT_CONTAINER) {
  const args = [
    "exec",
    container,
    "node",
    "/app/dist/index.js",
    "cron",
    "add",
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
    "--announce",
    "--channel",
    spec.channel,
    "--to",
    spec.to,
    "--best-effort-deliver",
    "--expect-final",
    "--timeout",
    String(spec.timeoutMs),
    "--json",
  ];
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    timeout: 30000,
  });
  if (result.status !== 0) {
    fail(cleanText(result.stderr) || cleanText(result.stdout) || `docker exec ${container} cron add failed`);
  }
  return JSON.parse(result.stdout || "{}");
}

export async function runInstall(options = {}) {
  const apply = options.apply === true;
  if (apply === options.dryRun) fail("Choose exactly one of --dry-run or --apply");

  const registryRoot = path.resolve(options.registryRoot || DEFAULT_REGISTRY_ROOT);
  const registries = options.registries || readGroupRegistries(registryRoot, {
    groupId: options.groupId,
    all: options.all,
  });
  const listJobs = options.listCronJobs || (() => listCronJobs(options.container || DEFAULT_CONTAINER));
  const addJob = options.addCronJob || ((spec) => addCronJob(spec, options.container || DEFAULT_CONTAINER));
  const existingJobs = options.existingJobs || listJobs();
  const jobs = planCronInstalls(registries, existingJobs, {
    cron: options.cron || DEFAULT_CRON,
    tz: options.tz || DEFAULT_TZ,
    agent: options.agent || DEFAULT_AGENT,
    timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
    containerRegistryRoot: options.containerRegistryRoot || DEFAULT_CONTAINER_REGISTRY_ROOT,
  });

  const added = [];
  if (apply) {
    for (const job of jobs) {
      if (job.action !== "add") continue;
      added.push({ name: job.name, result: addJob(job) });
    }
  }

  return {
    ok: true,
    mode: apply ? "apply" : "dry-run",
    registryRoot,
    totalRegistries: registries.length,
    jobs,
    addedCount: added.length,
    added,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help || args.h) {
    console.log(usage());
    return 0;
  }

  const result = await runInstall({
    dryRun: args["dry-run"] === true,
    apply: args.apply === true,
    all: args.all === true || !args.group,
    groupId: args.group || args.g || "",
    registryRoot: args["registry-root"],
    containerRegistryRoot: args["container-registry-root"],
    container: args.container,
    cron: args.cron,
    tz: args.tz,
    agent: args.agent,
  });
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
      process.exit(1);
    }
  );
}

export function writeRegistryForTest(registryRoot, registry) {
  mkdirSync(registryRoot, { recursive: true });
  const filePath = path.join(registryRoot, `${registry.groupId}.json`);
  writeFileSync(filePath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  return filePath;
}
