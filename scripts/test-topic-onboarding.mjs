#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  fetchForumTopics,
  getChatViaBotApi,
  getTelegramBotToken,
  parseArgs,
  runOnboarding,
  verifyGroupIsConfigured,
} from "../workspace/lib/telegram-topic-onboarding.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const DEFAULT_CONFIG_PATH = path.join(rootDir, "config", "openclaw.json");
const DEFAULT_REGISTRY_ROOT = path.join(rootDir, "workspace", "memory", "topic-intelligence", "groups");

function cleanText(value) {
  return String(value || "").trim();
}

function fail(message) {
  throw new Error(message);
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function pass(message) {
  console.log(`PASS ${message}`);
}

function warn(message) {
  console.log(`WARN ${message}`);
}

function usage() {
  return [
    "Usage:",
    "  node scripts/test-topic-onboarding.mjs --group -100...",
    "  node scripts/test-topic-onboarding.mjs --group -100... --runtime",
    "",
    "Options:",
    "  --config <path>         OpenClaw config path",
    "  --registry-root <path>  Topic registry groups directory",
    "  --tg-watcher-url <url>  tg-watcher base URL",
  ].join("\n");
}

function assertGroupId(groupId) {
  if (!/^-100\d+$/.test(cleanText(groupId))) fail("Missing or invalid --group");
}

function registryPathForGroup(registryRoot, groupId) {
  return path.join(path.resolve(registryRoot), `${groupId}.json`);
}

function topicTitleMatchesGoogleWorkspace(title) {
  return /\b(google workspace|workspace|gmail|calendar|drive|docs|sheets|meet|tasks|people|google chat)\b/i.test(
    cleanText(title)
  );
}

export function validateRoutePlan(routePlan, { requireExistingPreserved = false } = {}) {
  if (!Array.isArray(routePlan) || routePlan.length === 0) fail("No topic routes were planned");

  for (const route of routePlan) {
    if (!route.topicId) fail("A planned route is missing topicId");
    if (route.requireMention !== true) fail(`Topic ${route.topicId} is not mention-gated`);
    const legacyTopicAgent = ["general", "google_workspace"].includes(route.existingAgentId);
    if (route.existingAgentId && requireExistingPreserved && !legacyTopicAgent && route.action !== "preserve") {
      fail(`Existing topic ${route.topicId} route was not preserved`);
    }
  }

  const general = routePlan.find((route) => route.topicId === "1" || /^general$/i.test(route.title || ""));
  if (general && !/^topic_\d+_\d+$/.test(general.agentId)) {
    fail("General topic should route to a dedicated topic agent");
  }

  const google = routePlan.find((route) => topicTitleMatchesGoogleWorkspace(route.title));
  if (google && !/^topic_\d+_\d+$/.test(google.agentId)) {
    fail("Google Workspace topic should route to a dedicated topic agent");
  }
  if (google && !(google.skills || []).includes("gws-gmail")) {
    fail("Google Workspace topic should expose Google Workspace skills");
  }

  for (const route of routePlan) {
    if (
      route.topicId !== "1" &&
      !/^general$/i.test(route.title || "") &&
      !topicTitleMatchesGoogleWorkspace(route.title) &&
      !route.existingAgentId
    ) {
      if (!/^topic_\d+_\d+$/.test(route.agentId)) fail(`Unknown topic ${route.topicId} should route to a dedicated topic agent`);
      if (route.routingMode !== "topic_profile") fail(`Unknown topic ${route.topicId} should use a topic profile`);
      if (route.domainRoutingMode !== "adaptive") fail(`Unknown topic ${route.topicId} should use adaptive domain routing`);
    }
  }

  return true;
}

export function validateRegistry(registry, groupId) {
  if (!registry || typeof registry !== "object") fail("Registry is not valid JSON");
  if (registry.groupId !== groupId) fail(`Registry groupId mismatch: ${registry.groupId}`);
  if (registry.isForum !== true) fail("Registry does not mark group as forum-enabled");
  if (registry.onboardingStatus !== "active") fail(`Registry is not active: ${registry.onboardingStatus}`);
  if (!registry.topics || !Object.keys(registry.topics).length) fail("Registry contains no topics");
  return true;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help || args.h) {
    console.log(usage());
    return 0;
  }

  const groupId = cleanText(args.group || args.g);
  assertGroupId(groupId);

  const configPath = path.resolve(args.config || DEFAULT_CONFIG_PATH);
  const registryRoot = path.resolve(args["registry-root"] || DEFAULT_REGISTRY_ROOT);
  const config = readJson(configPath);
  const group = verifyGroupIsConfigured(config, groupId);
  pass("Group is configured under channels.telegram.groups");

  const topics = group.topics || {};
  if (!Object.keys(topics).length) fail("Group has no configured topic routes");
  pass(`Configured topic routes: ${Object.keys(topics).length}`);

  const registryPath = registryPathForGroup(registryRoot, groupId);
  if (existsSync(registryPath)) {
    const registry = readJson(registryPath);
    validateRegistry(registry, groupId);
    pass(`Registry exists with ${Object.keys(registry.topics || {}).length} topics`);
  } else {
    warn(`Registry is not present yet: ${registryPath}`);
  }

  if (args.runtime === true) {
    const chat = await getChatViaBotApi(groupId, getTelegramBotToken());
    if (String(chat.id) !== groupId) fail(`Telegram getChat returned unexpected id ${chat.id}`);
    if (chat.is_forum !== true) fail("Telegram group is not forum-enabled");
    pass("Bot API confirms forum group");

    const topicResult = await fetchForumTopics(groupId, args["tg-watcher-url"]);
    if (topicResult.isForum !== true) fail("tg-watcher reports group is not forum-enabled");
    pass(`tg-watcher discovered ${topicResult.topics?.length || 0} topics`);

    const dryRun = await runOnboarding({
      groupId,
      dryRun: true,
      apply: false,
      configPath,
      registryRoot,
      getChat: async () => chat,
      fetchForumTopics: async () => topicResult,
    });
    validateRoutePlan(dryRun.routes, { requireExistingPreserved: true });
    pass("Dry-run route plan is safe and idempotent");
  }

  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(`FAIL ${error.message}`);
      process.exit(1);
    }
  );
}
