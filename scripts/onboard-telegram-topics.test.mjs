import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildGroupRegistry,
  buildRoutePlan,
  listConfiguredTelegramGroupIds,
  patchConfig,
  planTopicRoute,
  runAllOnboarding,
  runOnboarding,
  topicAgentId,
} from "./onboard-telegram-topics.mjs";

const GROUP_ID = "-1001234567890";

function tempDir() {
  return mkdtempSync(path.join(tmpdir(), "openclaw-topic-onboarding-"));
}

function sampleConfig(extraGroup = {}) {
  return {
    channels: {
      telegram: {
        enabled: true,
        groups: {
          [GROUP_ID]: {
            requireMention: true,
            topics: {
              "1": {
                agentId: "general",
                requireMention: true,
                systemPrompt: "custom existing general prompt",
              },
            },
            ...extraGroup,
          },
        },
      },
    },
  };
}

function sampleTopics() {
  return [
    { id: "1", title: "General", closed: false, hidden: false, topMessage: "44" },
    { id: "4", title: "Google Workspace", closed: false, hidden: false, topMessage: "35" },
    { id: "27", title: "Education", closed: false, hidden: false, topMessage: "28" },
  ];
}

function writeConfig(dir, config = sampleConfig()) {
  const configPath = path.join(dir, "openclaw.json");
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return configPath;
}

async function runWithMocks(dir, overrides = {}) {
  return runOnboarding({
    groupId: GROUP_ID,
    dryRun: true,
    apply: false,
    configPath: writeConfig(dir, overrides.config || sampleConfig()),
    registryRoot: path.join(dir, "registry"),
    workspacesRoot: path.join(dir, "workspaces"),
    getChat: async () => ({ id: GROUP_ID, title: "Example Forum", is_forum: true }),
    fetchForumTopics: async () => ({
      ok: true,
      groupId: GROUP_ID,
      title: "Example Forum",
      isForum: true,
      topics: sampleTopics(),
    }),
    ...overrides,
  });
}

test("planTopicRoute maps known and unknown topics", () => {
  assert.equal(planTopicRoute({ id: "1", title: "Anything" }, { groupId: GROUP_ID }).agentId, topicAgentId(GROUP_ID, "1"));
  assert.equal(planTopicRoute({ id: "4", title: "Google Workspace" }, { groupId: GROUP_ID }).agentId, topicAgentId(GROUP_ID, "4"));
  assert.equal(planTopicRoute({ id: "27", title: "Education" }, { groupId: GROUP_ID }).agentId, topicAgentId(GROUP_ID, "27"));
  assert.equal(planTopicRoute({ id: "27", title: "Education" }, { groupId: GROUP_ID }).routingMode, "topic_profile");
  assert.equal(planTopicRoute({ id: "27", title: "Education" }, { groupId: GROUP_ID }).domainRoutingMode, "adaptive");
});

test("buildRoutePlan updates legacy routes to dedicated topic profiles", () => {
  const routes = buildRoutePlan(sampleConfig(), GROUP_ID, sampleTopics());
  assert.deepEqual(
    routes.map((route) => [route.topicId, route.agentId, route.action]),
    [
      ["1", topicAgentId(GROUP_ID, "1"), "update"],
      ["4", topicAgentId(GROUP_ID, "4"), "add"],
      ["27", topicAgentId(GROUP_ID, "27"), "add"],
    ]
  );
});

test("custom existing routes are preserved unless force is used", () => {
  const config = sampleConfig({
    topics: {
      "4": {
        agentId: "custom_workspace_agent",
        requireMention: true,
        systemPrompt: "old",
      },
    },
  });
  const preserved = buildRoutePlan(config, GROUP_ID, sampleTopics());
  const preservedGoogleRoute = preserved.find((route) => route.topicId === "4");
  assert.equal(preservedGoogleRoute.agentId, "custom_workspace_agent");
  assert.equal(preservedGoogleRoute.action, "preserve");

  const routes = buildRoutePlan(config, GROUP_ID, sampleTopics(), { force: true });
  const googleRoute = routes.find((route) => route.topicId === "4");
  assert.equal(googleRoute.agentId, topicAgentId(GROUP_ID, "4"));
  assert.equal(googleRoute.action, "update");
});

test("patchConfig adds topics and keeps existing custom routes", () => {
  const config = sampleConfig();
  const routes = buildRoutePlan(config, GROUP_ID, sampleTopics());
  const result = patchConfig(config, GROUP_ID, routes);
  const topics = result.config.channels.telegram.groups[GROUP_ID].topics;

  assert.equal(result.changed, true);
  assert.equal(topics["1"].agentId, topicAgentId(GROUP_ID, "1"));
  assert.equal(topics["4"].agentId, topicAgentId(GROUP_ID, "4"));
  assert.equal(topics["27"].agentId, topicAgentId(GROUP_ID, "27"));
  assert.equal(topics["27"].requireMention, true);
  assert.equal(result.config.agents.list.length, 3);
  assert.equal(
    result.config.agents.list.find((agent) => agent.id === topicAgentId(GROUP_ID, "4")).skills.includes("gws-gmail"),
    true,
  );
});

test("patchConfig reports no config change when all existing routes are preserved", () => {
  const topic1 = topicAgentId(GROUP_ID, "1");
  const topic4 = topicAgentId(GROUP_ID, "4");
  const topic27 = topicAgentId(GROUP_ID, "27");
  const config = sampleConfig({
    topics: {
      "1": { agentId: topic1, requireMention: true, systemPrompt: "custom general" },
      "4": { agentId: topic4, requireMention: true, systemPrompt: "custom workspace" },
      "27": { agentId: topic27, requireMention: true, systemPrompt: "custom adaptive" },
    },
  });
  config.agents = {
    list: [
      {
        id: topic1,
        name: "General Topic",
        workspace: `/home/node/.openclaw/workspaces/${topic1}`,
        agentDir: `/home/node/.openclaw/agents/${topic1}/agent`,
        skills: ["telegram", "telegram-send", "topic-intelligence", "healthcheck", "weather", "taskflow"],
      },
      {
        id: topic4,
        name: "Google Workspace Topic",
        workspace: `/home/node/.openclaw/workspaces/${topic4}`,
        agentDir: `/home/node/.openclaw/agents/${topic4}/agent`,
        skills: ["telegram", "telegram-send", "topic-intelligence", "gws-shared", "gws-calendar", "gws-gmail", "gws-drive"],
      },
      {
        id: topic27,
        name: "Education Topic",
        workspace: `/home/node/.openclaw/workspaces/${topic27}`,
        agentDir: `/home/node/.openclaw/agents/${topic27}/agent`,
        skills: ["telegram", "telegram-send", "topic-intelligence"],
      },
    ],
  };
  const routes = buildRoutePlan(config, GROUP_ID, sampleTopics());
  const result = patchConfig(config, GROUP_ID, routes);

  assert.equal(result.changed, false);
  assert.deepEqual(result.config, config);
});

test("patchConfig treats generated topic agent allowlists as authoritative", () => {
  const topic4 = topicAgentId(GROUP_ID, "4");
  const config = sampleConfig({
    topics: {
      "4": { agentId: topic4, requireMention: true, systemPrompt: "custom workspace" },
    },
  });
  config.agents = {
    list: [
      {
        id: topic4,
        name: "Google Workspace Topic",
        workspace: `/home/node/.openclaw/workspaces/${topic4}`,
        agentDir: `/home/node/.openclaw/agents/${topic4}/agent`,
        skills: [
          "telegram",
          "telegram-send",
          "topic-intelligence",
          "gws-shared",
          "gws-calendar",
          "gws-gmail",
          "gws-drive",
          "old-unrecorded-skill",
        ],
      },
    ],
  };

  const routes = buildRoutePlan(config, GROUP_ID, [
    { id: "4", title: "Education", closed: false, hidden: false, topMessage: "101" },
  ]);
  const result = patchConfig(config, GROUP_ID, routes, {
    previousRegistry: {
      topics: {
        "4": {
          localSkillsCreated: [{ name: "education-topic-triage" }],
        },
      },
    },
  });
  const skills = result.config.agents.list.find((agent) => agent.id === topic4).skills;

  assert.equal(result.changed, true);
  assert.deepEqual(skills, [
    "telegram",
    "telegram-send",
    "topic-intelligence",
    "education-topic-triage",
  ]);
});

test("buildGroupRegistry updates renamed topics by id and marks missing topics stale", () => {
  const registry = buildGroupRegistry({
    previousRegistry: {
      groupId: GROUP_ID,
      title: "Example Forum",
      isForum: true,
      onboardingStatus: "active",
      topics: {
        "4": {
          title: "Old Workspace",
          status: "active",
          agentId: topicAgentId(GROUP_ID, "4"),
          routingMode: "topic_profile",
          inferredDomain: "google_workspace",
          evidenceLevel: "high",
          skills: ["gws-gmail"],
          repeatedWorkflows: [{ name: "triage inbox", repeatedWorkflowCount: 3 }],
          localSkillsCreated: [{ name: "workspace-topic-triage" }],
          localSkillsUpdated: [],
          pluginRecommendations: [{ candidate: "trusted-plugin" }],
          lastSeenAt: "2026-05-20T00:00:00.000Z",
        },
        "9": {
          title: "Legacy Topic",
          status: "active",
          agentId: topicAgentId(GROUP_ID, "9"),
          routingMode: "topic_profile",
          inferredDomain: "legacy",
          evidenceLevel: "medium",
          lastSeenAt: "2026-05-19T00:00:00.000Z",
        },
      },
    },
    groupId: GROUP_ID,
    title: "Example Forum",
    isForum: true,
    now: "2026-05-25T07:00:00.000Z",
    routePlan: buildRoutePlan(
      sampleConfig({
        topics: {
          "4": { agentId: topicAgentId(GROUP_ID, "4"), requireMention: true, systemPrompt: "custom" },
        },
      }),
      GROUP_ID,
      [{ id: "4", title: "Google Workspace Renamed", closed: false, hidden: false, topMessage: "101" }],
    ),
  });

  assert.equal(registry.topics["4"].title, "Google Workspace Renamed");
  assert.equal(registry.topics["4"].status, "active");
  assert.equal(registry.topics["4"].agentId, topicAgentId(GROUP_ID, "4"));
  assert.deepEqual(registry.topics["4"].repeatedWorkflows, [
    { name: "triage inbox", repeatedWorkflowCount: 3 },
  ]);
  assert.deepEqual(registry.topics["4"].pluginRecommendations, [{ candidate: "trusted-plugin" }]);
  assert.equal(registry.topics["9"].status, "stale");
  assert.equal(registry.topics["9"].lastSeenAt, "2026-05-19T00:00:00.000Z");
  assert.equal(registry.topics["9"].staleAt, "2026-05-25T07:00:00.000Z");
});

test("buildGroupRegistry marks closed or hidden discovered topics inactive", () => {
  const registry = buildGroupRegistry({
    groupId: GROUP_ID,
    title: "Example Forum",
    isForum: true,
    now: "2026-05-25T07:00:00.000Z",
    routePlan: buildRoutePlan(sampleConfig(), GROUP_ID, [
      { id: "44", title: "Closed", closed: true, hidden: false },
      { id: "45", title: "Hidden", closed: false, hidden: true },
    ]),
  });

  assert.equal(registry.topics["44"].status, "inactive");
  assert.equal(registry.topics["45"].status, "inactive");
});

test("runOnboarding refuses groups absent from config", async () => {
  const dir = tempDir();
  try {
    await assert.rejects(
      () =>
        runWithMocks(dir, {
          config: {
            channels: { telegram: { enabled: true, groups: {} } },
          },
        }),
      /not configured/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listConfiguredTelegramGroupIds returns Bot API supergroups only", () => {
  assert.deepEqual(
    listConfiguredTelegramGroupIds({
      channels: {
        telegram: {
          groups: {
            [GROUP_ID]: {},
            "-12345": {},
            not_a_group: {},
          },
        },
      },
    }),
    [GROUP_ID],
  );
});

test("dry-run prints preview data without writing files", async () => {
  const dir = tempDir();
  try {
    const configPath = writeConfig(dir);
    const before = readFileSync(configPath, "utf8");
    const registryRoot = path.join(dir, "registry");
    const result = await runOnboarding({
      groupId: GROUP_ID,
      dryRun: true,
      apply: false,
      configPath,
      registryRoot,
      workspacesRoot: path.join(dir, "workspaces"),
      getChat: async () => ({ id: GROUP_ID, title: "Example Forum", is_forum: true }),
      fetchForumTopics: async () => ({ ok: true, isForum: true, topics: sampleTopics() }),
    });

    assert.equal(result.mode, "dry-run");
    assert.equal(result.configChanged, true);
    assert.equal(result.topicsDiscovered, 3);
    assert.equal(readFileSync(configPath, "utf8"), before);
    assert.equal(existsSync(registryRoot), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("apply writes backup, patched config, group registry, and index in temp paths", async () => {
  const dir = tempDir();
  try {
    const configPath = writeConfig(dir);
    const registryRoot = path.join(dir, "registry");
    const result = await runOnboarding({
      groupId: GROUP_ID,
      dryRun: false,
      apply: true,
      configPath,
      registryRoot,
      workspacesRoot: path.join(dir, "workspaces"),
      now: "2026-05-25T07:00:00.000Z",
      getChat: async () => ({ id: GROUP_ID, title: "Example Forum", is_forum: true }),
      fetchForumTopics: async () => ({ ok: true, isForum: true, topics: sampleTopics() }),
    });

    assert.equal(result.mode, "apply");
    assert.equal(existsSync(result.backupPath), true);
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    assert.equal(config.channels.telegram.groups[GROUP_ID].topics["4"].agentId, topicAgentId(GROUP_ID, "4"));
    assert.equal(config.channels.telegram.groups[GROUP_ID].topics["27"].agentId, topicAgentId(GROUP_ID, "27"));
    assert.equal(config.agents.list.some((agent) => agent.id === topicAgentId(GROUP_ID, "27")), true);

    const registryPath = path.join(registryRoot, `${GROUP_ID}.json`);
    const indexPath = path.join(registryRoot, "index.json");
    assert.equal(existsSync(registryPath), true);
    assert.equal(existsSync(indexPath), true);

    const registry = JSON.parse(readFileSync(registryPath, "utf8"));
    assert.equal(registry.topics["27"].routingMode, "topic_profile");
    assert.equal(registry.topics["27"].domainRoutingMode, "adaptive");
    assert.equal(registry.topics["4"].agentId, topicAgentId(GROUP_ID, "4"));
    assert.equal(
      existsSync(path.join(dir, "workspaces", topicAgentId(GROUP_ID, "27"), "AGENTS.md")),
      true,
    );

    const index = JSON.parse(readFileSync(indexPath, "utf8"));
    assert.equal(index.groups[GROUP_ID].topicCount, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runAllOnboarding dry-runs every configured forum supergroup", async () => {
  const dir = tempDir();
  try {
    const otherGroupId = "-1002222222222";
    const configPath = writeConfig(dir, {
      channels: {
        telegram: {
          enabled: true,
          groups: {
            [GROUP_ID]: { requireMention: true },
            [otherGroupId]: { requireMention: true },
          },
        },
      },
    });
    const result = await runAllOnboarding({
      dryRun: true,
      apply: false,
      configPath,
      registryRoot: path.join(dir, "registry"),
      workspacesRoot: path.join(dir, "workspaces"),
      getChat: async (groupId) => ({ id: groupId, title: `Forum ${groupId}`, is_forum: true }),
      fetchForumTopics: async () => ({ ok: true, isForum: true, topics: sampleTopics() }),
    });

    assert.equal(result.mode, "dry-run");
    assert.equal(result.groupCount, 2);
    assert.deepEqual(result.groups.map((group) => group.groupId), [GROUP_ID, otherGroupId]);
    assert.equal(result.groups[0].topicsDiscovered, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
