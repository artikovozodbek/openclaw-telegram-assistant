#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH || "/home/node/.openclaw/openclaw.json";

function cleanText(value) {
  return String(value || "").trim();
}

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
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

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function isManagedTopicAgentId(agentId) {
  return /^topic_\d+_\d+$/.test(cleanText(agentId));
}

function namedRecordName(value) {
  if (typeof value === "string") return cleanText(value);
  if (!value || typeof value !== "object") return "";
  return cleanText(value.name || value.skillName || value.skill || value.id);
}

function localSkillNames(topic) {
  return [
    ...(Array.isArray(topic?.localSkillsCreated) ? topic.localSkillsCreated : []),
    ...(Array.isArray(topic?.localSkillsUpdated) ? topic.localSkillsUpdated : []),
  ].map(namedRecordName).filter(Boolean);
}

function topicEntries(registry) {
  return Object.entries(registry?.topics || {}).map(([topicId, topic]) => ({
    topicId,
    topic: topic && typeof topic === "object" ? topic : {},
  }));
}

export function updateConfigWithRegistryAllowlists(config, registry) {
  const next = structuredClone(config);
  const agents = next.agents?.list;
  if (!Array.isArray(agents)) return { config: next, changed: false, updatedAgents: [] };

  let changed = false;
  const updatedAgents = [];
  for (const { topicId, topic } of topicEntries(registry)) {
    const agentId = cleanText(topic.agentId);
    if (!isManagedTopicAgentId(agentId)) continue;
    const agent = agents.find((candidate) => candidate.id === agentId);
    if (!agent) continue;

    const desired = [
      ...(Array.isArray(topic.skills) ? topic.skills : []),
      ...localSkillNames(topic),
    ].map(cleanText).filter(Boolean);
    if (!desired.length) continue;
    const nextSkills = [...new Set(desired)];
    if (JSON.stringify(agent.skills || []) !== JSON.stringify(nextSkills)) {
      agent.skills = nextSkills;
      changed = true;
      updatedAgents.push({ topicId, agentId, skillCount: nextSkills.length });
    }
  }

  return { config: next, changed, updatedAgents };
}

export async function run(options = {}) {
  const apply = options.apply === true;
  if (apply === (options.dryRun === true)) fail("Choose exactly one of --dry-run or --apply");

  const registryPath = path.resolve(options.registryPath || "");
  const configPath = path.resolve(options.configPath || DEFAULT_CONFIG_PATH);
  if (!registryPath) fail("Missing --registry <path>");
  if (!existsSync(registryPath)) fail(`Missing registry: ${registryPath}`);
  if (!existsSync(configPath)) fail(`Missing config: ${configPath}`);

  const registry = readJson(registryPath);
  const result = updateConfigWithRegistryAllowlists(readJson(configPath), registry);
  if (apply && result.changed) writeJson(configPath, result.config);

  return {
    ok: true,
    mode: apply ? "apply" : "dry-run",
    registry: registryPath,
    config: configPath,
    changed: result.changed,
    updatedAgents: result.updatedAgents,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help || args.h) {
    console.log([
      "Usage:",
      "  node topic-agent-allowlists.mjs --registry <group-registry.json> --dry-run",
      "  node topic-agent-allowlists.mjs --registry <group-registry.json> --apply",
      "",
      "Options:",
      "  --config <path>  OpenClaw config path",
    ].join("\n"));
    return 0;
  }
  const result = await run({
    registryPath: args.registry,
    configPath: args.config,
    dryRun: args["dry-run"] === true,
    apply: args.apply === true,
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
