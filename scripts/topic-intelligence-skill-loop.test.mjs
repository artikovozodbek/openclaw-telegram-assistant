import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  planSkillLoop,
  runSkillLoop,
  updateConfigWithTopicSkillAllowlists,
  validateSkillMarkdown,
} from "./topic-intelligence-skill-loop.mjs";

function tempDir() {
  return mkdtempSync(path.join(tmpdir(), "openclaw-topic-skill-loop-"));
}

function registryWithTopic(topic) {
  return {
    groupId: "-1001234567890",
    title: "Example Forum",
    isForum: true,
    onboardingStatus: "active",
    topics: {
      [topic.id || "2"]: topic,
    },
  };
}

function writeRegistry(dir, registry) {
  const registryPath = path.join(dir, "registry.json");
  writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  return registryPath;
}

test("repeated Odoo workflow proposes odoo-topic-triage", () => {
  const plan = planSkillLoop(
    registryWithTopic({
      id: "2",
      title: "Odoo",
      inferredDomain: "Odoo",
      repeatedWorkflows: [
        {
          name: "Odoo triage",
          description: "Classify requests by module, current behavior, expected behavior, logs, and acceptance criteria.",
          repeatedWorkflowCount: 3,
          evidenceLevel: "high",
        },
      ],
    }),
    { skillsRoot: "tmp-skills" }
  );

  assert.equal(plan.proposals.length, 1);
  assert.equal(plan.proposals[0].skillName, "odoo-topic-triage");
  assert.equal(plan.pluginRecommendations.length, 0);
});

test("title-only Odoo topic does not create a skill", () => {
  const plan = planSkillLoop(
    registryWithTopic({
      id: "2",
      title: "Odoo",
      inferredDomain: "Odoo",
    }),
    { skillsRoot: "tmp-skills" }
  );

  assert.equal(plan.proposals.length, 0);
  assert.equal(plan.skipped[0].reason, "insufficient_evidence");
});

test("unsafe external install request becomes plugin recommendation only", () => {
  const plan = planSkillLoop(
    registryWithTopic({
      id: "2",
      title: "Odoo",
      inferredDomain: "Odoo",
      repeatedWorkflows: [
        {
          name: "Install Odoo connector",
          description: "Install npm package and external plugin for Odoo API access.",
          repeatedWorkflowCount: 5,
          candidatePlugin: "official-openclaw-odoo",
          requiresExternalInstall: true,
        },
      ],
    }),
    { skillsRoot: "tmp-skills" }
  );

  assert.equal(plan.proposals.length, 0);
  assert.equal(plan.pluginRecommendations.length, 1);
  assert.equal(plan.pluginRecommendations[0].approvalNeeded, true);
});

test("generated skill validation passes and secret-shaped text fails", () => {
  const valid = `---
name: odoo-topic-triage
description: Use this skill for repeated Odoo workflows.
---

# Odoo Topic Triage

Workflow:
1. Triage the request.

Safety:
- Do not expose secrets.
`;
  assert.equal(validateSkillMarkdown("odoo-topic-triage", valid), true);

  const invalid = valid.replace("Do not expose secrets.", "API_KEY=sk-redacted");
  assert.throws(() => validateSkillMarkdown("odoo-topic-triage", invalid), /secret-shaped/);
});

test("apply mode writes generated skill only under provided skills root", async () => {
  const dir = tempDir();
  try {
    const skillsRoot = path.join(dir, "skills");
    const registryPath = writeRegistry(
      dir,
      registryWithTopic({
        id: "2",
        title: "Odoo",
        inferredDomain: "Odoo",
        repeatedWorkflows: [
          {
            name: "Odoo triage",
            repeatedWorkflowCount: 3,
            evidenceLevel: "high",
          },
        ],
      })
    );

    const result = await runSkillLoop({
      registryPath,
      skillsRoot,
      dryRun: false,
      apply: true,
      now: "2026-05-25T10:00:00.000Z",
    });

    const skillPath = path.join(skillsRoot, "odoo-topic-triage", "SKILL.md");
    assert.deepEqual(result.written, [skillPath]);
    assert.equal(existsSync(skillPath), true);
    assert.match(readFileSync(skillPath, "utf8"), /^name: odoo-topic-triage$/m);
    assert.equal(result.registryWritten, true);

    const registry = JSON.parse(readFileSync(registryPath, "utf8"));
    assert.equal(registry.topics["2"].localSkillsCreated[0].name, "odoo-topic-triage");
    assert.equal(registry.topics["2"].localSkillsCreated[0].createdAt, "2026-05-25T10:00:00.000Z");
    assert.deepEqual(registry.topics["2"].localSkillsUpdated, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("apply mode can add generated local skills to the topic agent allowlist", async () => {
  const dir = tempDir();
  try {
    const skillsRoot = path.join(dir, "skills");
    const registryPath = writeRegistry(
      dir,
      registryWithTopic({
        id: "2",
        title: "Odoo",
        agentId: "topic_1001234567890_2",
        inferredDomain: "Odoo",
        skills: ["telegram", "telegram-send", "topic-intelligence"],
        repeatedWorkflows: [
          {
            name: "Odoo triage",
            repeatedWorkflowCount: 3,
            evidenceLevel: "high",
          },
        ],
      })
    );
    const configPath = path.join(dir, "openclaw.json");
    writeFileSync(configPath, `${JSON.stringify({
      agents: {
        list: [
          {
            id: "main",
            skills: ["telegram"],
          },
          {
            id: "topic_1001234567890_2",
            skills: ["telegram", "telegram-send", "topic-intelligence"],
          },
        ],
      },
    }, null, 2)}\n`, "utf8");

    const result = await runSkillLoop({
      registryPath,
      skillsRoot,
      configPath,
      dryRun: false,
      apply: true,
      now: "2026-05-25T10:00:00.000Z",
    });

    assert.equal(result.configWritten, true);
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    assert.deepEqual(config.agents.list.find((agent) => agent.id === "main").skills, ["telegram"]);
    assert.equal(
      config.agents.list.find((agent) => agent.id === "topic_1001234567890_2").skills.includes("odoo-topic-triage"),
      true,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("updateConfigWithTopicSkillAllowlists ignores main and non-topic agents", () => {
  const result = updateConfigWithTopicSkillAllowlists(
    {
      agents: {
        list: [
          { id: "main", skills: ["telegram"] },
          { id: "custom", skills: ["telegram"] },
          { id: "topic_1001234567890_2", skills: ["telegram"] },
        ],
      },
    },
    registryWithTopic({
      id: "2",
      agentId: "topic_1001234567890_2",
      skills: ["telegram", "topic-intelligence"],
      localSkillsCreated: [{ name: "odoo-topic-triage" }],
    })
  );
  assert.equal(result.changed, true);
  assert.deepEqual(result.config.agents.list.find((agent) => agent.id === "main").skills, ["telegram"]);
  assert.deepEqual(result.config.agents.list.find((agent) => agent.id === "custom").skills, ["telegram"]);
  assert.equal(
    result.config.agents.list.find((agent) => agent.id === "topic_1001234567890_2").skills.includes("odoo-topic-triage"),
    true,
  );
});

test("updateConfigWithTopicSkillAllowlists removes stale generated topic skills", () => {
  const result = updateConfigWithTopicSkillAllowlists(
    {
      agents: {
        list: [
          {
            id: "topic_1001234567890_2",
            skills: ["telegram", "topic-intelligence", "gws-gmail", "old-topic-skill"],
          },
        ],
      },
    },
    registryWithTopic({
      id: "2",
      agentId: "topic_1001234567890_2",
      skills: ["telegram", "telegram-send", "topic-intelligence"],
      localSkillsCreated: [{ name: "odoo-topic-triage" }],
    })
  );

  assert.equal(result.changed, true);
  assert.deepEqual(result.config.agents.list[0].skills, [
    "telegram",
    "telegram-send",
    "topic-intelligence",
    "odoo-topic-triage",
  ]);
});

test("apply mode records external install gaps as plugin recommendations", async () => {
  const dir = tempDir();
  try {
    const registryPath = writeRegistry(
      dir,
      registryWithTopic({
        id: "2",
        title: "Odoo",
        inferredDomain: "Odoo",
        repeatedWorkflows: [
          {
            name: "Odoo connector",
            description: "Install an external connector for Odoo API access.",
            repeatedWorkflowCount: 3,
            candidatePlugin: "official-openclaw-odoo",
            requiresExternalInstall: true,
          },
        ],
      })
    );

    const result = await runSkillLoop({
      registryPath,
      skillsRoot: path.join(dir, "skills"),
      dryRun: false,
      apply: true,
      now: "2026-05-25T10:30:00.000Z",
    });

    assert.deepEqual(result.written, []);
    const registry = JSON.parse(readFileSync(registryPath, "utf8"));
    assert.equal(registry.topics["2"].pluginRecommendations.length, 1);
    assert.equal(registry.topics["2"].pluginRecommendations[0].candidate, "official-openclaw-odoo");
    assert.equal(registry.topics["2"].pluginRecommendations[0].approvalNeeded, true);
    assert.equal(registry.topics["2"].pluginRecommendations[0].recommendedAt, "2026-05-25T10:30:00.000Z");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


