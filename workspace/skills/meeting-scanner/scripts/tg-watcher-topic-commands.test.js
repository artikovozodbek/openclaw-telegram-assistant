"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  authorizeTopicCommand,
  botApiGroupIdFromPeer,
  disableLegacyAuditCronIfRedundant,
  executeTopicCommand,
  formatActivateSummary,
  formatOnboardSummary,
  parseTopicCommand,
  senderIdFromMessage,
  topicThreadIdFromMessage,
} = require("./tg-watcher-topic-commands");

const GROUP_ID = "-1001234567890";

function config() {
  return {
    channels: {
      telegram: {
        enabled: true,
        allowFrom: ["111"],
        groupAllowFrom: ["222"],
        groups: {
          [GROUP_ID]: {
            requireMention: true,
            topics: {
              "1": { agentId: "general" },
              "4": { agentId: "google_workspace" },
            },
          },
        },
      },
    },
  };
}

function registry() {
  return {
    groupId: GROUP_ID,
    title: "Example Forum",
    topics: {
      "1": {
        title: "General",
        status: "active",
        agentId: "general",
        routingMode: "static",
        skills: ["telegram", "topic-intelligence"],
      },
      "4": {
        title: "Google Workspace",
        status: "active",
        agentId: "google_workspace",
        routingMode: "static",
        skills: ["gws-gmail"],
        localSkillsCreated: [{ name: "workspace-topic-triage" }],
        pluginRecommendations: [{ candidate: "official-openclaw-workspace", workflow: "shared drive audit" }],
      },
    },
  };
}

test("parseTopicCommand accepts bot suffixes and known commands only", () => {
  assert.equal(parseTopicCommand("/topic-activate"), "topic-activate");
  assert.equal(parseTopicCommand("/topic-onboard"), "topic-onboard");
  assert.equal(parseTopicCommand("/topic-routes@jarvis_test123_bot"), "topic-routes");
  assert.equal(parseTopicCommand(" /topic-skills please"), "topic-skills");
  assert.equal(parseTopicCommand("/unknown"), null);
});

test("formatActivateSummary reports profiles and automation without config dumps", () => {
  const text = formatActivateSummary({
    ok: true,
    onboarding: {
      groupId: GROUP_ID,
      title: "Example Forum",
      topicsDiscovered: 2,
      routes: [
        { action: "add", agentId: "topic_1001234567890_1" },
        { action: "update", agentId: "topic_1001234567890_4" },
      ],
    },
    crons: [
      { name: "topic-intelligence-daily--1001234567890", action: "add" },
      { name: "telegram-topic-onboarding--1001234567890", action: "exists" },
    ],
    cronCleanup: { name: "topic-intelligence-daily", action: "disable" },
  });
  assert.match(text, /Topic activation complete/);
  assert.match(text, /Dedicated profiles: 2/);
  assert.match(text, /topic-intelligence-daily/);
  assert.match(text, /Legacy topic-intelligence-daily disabled/);
  assert.doesNotMatch(text, /openclaw\.json|systemPrompt|botToken/);
});

test("group and sender ids normalize Telegram peer shapes", () => {
  assert.equal(botApiGroupIdFromPeer({ className: "PeerChannel", channelId: 1234567890n }), GROUP_ID);
  assert.equal(botApiGroupIdFromPeer({ className: "PeerChat", chatId: 777 }), "-777");
  assert.equal(senderIdFromMessage({ senderId: { value: 222n } }), "222");
  assert.equal(topicThreadIdFromMessage({ replyTo: { replyToTopId: 4 } }), "4");
});

test("authorizeTopicCommand requires configured group and allowed sender", () => {
  assert.equal(authorizeTopicCommand(config(), GROUP_ID, "222").ok, true);
  assert.equal(authorizeTopicCommand(config(), GROUP_ID, "333").ok, false);
  assert.equal(authorizeTopicCommand(config(), "-1009999999999", "222").ok, false);
});

test("formatOnboardSummary avoids config dumps", () => {
  const text = formatOnboardSummary({
    ok: true,
    groupId: GROUP_ID,
    title: "Example Forum",
    topicsDiscovered: 3,
    registryTopicCount: 3,
    configChanged: true,
    routes: [
      { action: "add" },
      { action: "preserve" },
      { action: "preserve" },
    ],
  });
  assert.match(text, /Topic onboarding complete/);
  assert.match(text, /1 added/);
  assert.doesNotMatch(text, /openclaw\.json|systemPrompt|botToken/);
});

test("executeTopicCommand returns route, skill, plugin, audit, and onboard summaries", async () => {
  const base = { groupId: GROUP_ID, senderId: "222" };
  const deps = {
    config: config(),
    registry: registry(),
    env: {},
    runOnboard: async () => ({
      ok: true,
      groupId: GROUP_ID,
      title: "Example Forum",
      topicsDiscovered: 2,
      registryTopicCount: 2,
      configChanged: false,
      routes: [{ action: "preserve" }, { action: "preserve" }],
    }),
    runActivate: async () => ({
      ok: true,
      onboarding: {
        groupId: GROUP_ID,
        title: "Example Forum",
        topicsDiscovered: 2,
        routes: [
          { action: "preserve", agentId: "topic_1001234567890_1" },
          { action: "preserve", agentId: "topic_1001234567890_4" },
        ],
      },
      crons: [{ name: "topic-intelligence-daily--1001234567890", action: "exists" }],
    }),
    listCronJobs: async () => [{ name: "topic-intelligence-daily--1001234567890" }],
    runCronJob: async () => ({ ok: true }),
  };

  assert.match((await executeTopicCommand({ ...base, text: "/topic-routes" }, deps)).text, /Google Workspace: google_workspace/);
  assert.match((await executeTopicCommand({ ...base, text: "/topic-skills" }, deps)).text, /workspace-topic-triage/);
  assert.match((await executeTopicCommand({ ...base, text: "/topic-plugin-suggestions" }, deps)).text, /official-openclaw-workspace/);
  assert.match((await executeTopicCommand({ ...base, text: "/topic-audit-now" }, deps)).text, /Topic audit started/);
  assert.match((await executeTopicCommand({ ...base, text: "/topic-onboard" }, deps)).text, /Config changed: no/);
  assert.match((await executeTopicCommand({ ...base, text: "/topic-activate" }, deps)).text, /Dedicated profiles/);
});

test("executeTopicCommand rejects unauthorized senders", async () => {
  const result = await executeTopicCommand(
    { groupId: GROUP_ID, senderId: "333", text: "/topic-routes" },
    { config: config(), registry: registry(), env: {} },
  );
  assert.equal(result.ok, false);
  assert.match(result.text, /Only configured/);
});

test("disableLegacyAuditCronIfRedundant disables old global audit only when a per-group job exists", async () => {
  const calls = [];
  const result = await disableLegacyAuditCronIfRedundant(
    [
      { id: "legacy-id", name: "topic-intelligence-daily", enabled: true },
      { id: "group-id", name: "topic-intelligence-daily--1001234567890", enabled: true },
    ],
    GROUP_ID,
    {
      runProcess: async (command, args) => {
        calls.push({ command, args });
        return { status: 0, stdout: "{}", stderr: "" };
      },
    },
  );

  assert.deepEqual(result, { name: "topic-intelligence-daily", action: "disable" });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ["/app/dist/index.js", "cron", "edit", "legacy-id", "--disable"]);

  const skipped = await disableLegacyAuditCronIfRedundant(
    [{ id: "legacy-id", name: "topic-intelligence-daily", enabled: true }],
    GROUP_ID,
    {
      runProcess: async () => {
        throw new Error("should not run");
      },
    },
  );
  assert.deepEqual(skipped, { name: "topic-intelligence-daily", action: "not-needed" });
});
