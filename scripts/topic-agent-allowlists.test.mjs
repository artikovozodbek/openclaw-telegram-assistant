import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  run,
  updateConfigWithRegistryAllowlists,
} from "../workspace/bin/topic-agent-allowlists.mjs";

function tempDir() {
  return mkdtempSync(path.join(tmpdir(), "openclaw-topic-allowlists-"));
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test("updateConfigWithRegistryAllowlists updates only generated topic agents", () => {
  const result = updateConfigWithRegistryAllowlists(
    {
      agents: {
        list: [
          { id: "main", skills: ["telegram"] },
          { id: "custom", skills: ["telegram"] },
          { id: "topic_1001234567890_2", skills: ["telegram"] },
        ],
      },
    },
    {
      topics: {
        "2": {
          agentId: "topic_1001234567890_2",
          skills: ["telegram", "topic-intelligence"],
          localSkillsCreated: [{ name: "odoo-topic-triage" }],
        },
        "9": {
          agentId: "custom",
          skills: ["should-not-be-added"],
        },
      },
    }
  );

  assert.equal(result.changed, true);
  assert.deepEqual(result.config.agents.list.find((agent) => agent.id === "main").skills, ["telegram"]);
  assert.deepEqual(result.config.agents.list.find((agent) => agent.id === "custom").skills, ["telegram"]);
  const topicAgent = result.config.agents.list.find((agent) => agent.id === "topic_1001234567890_2");
  assert.equal(topicAgent.skills.includes("topic-intelligence"), true);
  assert.equal(topicAgent.skills.includes("odoo-topic-triage"), true);
});

test("updateConfigWithRegistryAllowlists removes stale generated topic skills", () => {
  const result = updateConfigWithRegistryAllowlists(
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
    {
      topics: {
        "2": {
          agentId: "topic_1001234567890_2",
          skills: ["telegram", "telegram-send", "topic-intelligence"],
          localSkillsCreated: [{ name: "odoo-topic-triage" }],
        },
      },
    }
  );

  assert.equal(result.changed, true);
  assert.deepEqual(result.config.agents.list[0].skills, [
    "telegram",
    "telegram-send",
    "topic-intelligence",
    "odoo-topic-triage",
  ]);
});

test("run applies registry allowlists to a config file", async () => {
  const dir = tempDir();
  try {
    const registryPath = path.join(dir, "registry.json");
    const configPath = path.join(dir, "openclaw.json");
    writeJson(registryPath, {
      topics: {
        "2": {
          agentId: "topic_1001234567890_2",
          skills: ["telegram", "topic-intelligence"],
          localSkillsUpdated: ["odoo-topic-triage"],
        },
      },
    });
    writeJson(configPath, {
      agents: {
        list: [{ id: "topic_1001234567890_2", skills: ["telegram"] }],
      },
    });

    const result = await run({
      registryPath,
      configPath,
      apply: true,
      dryRun: false,
    });

    assert.equal(result.changed, true);
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    assert.equal(
      config.agents.list[0].skills.includes("odoo-topic-triage"),
      true,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
