import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildCronMessage,
  buildCronSpec,
  planCronInstalls,
  readGroupRegistries,
  runInstall,
  safeGroupId,
  writeRegistryForTest,
} from "./install-topic-intelligence-cron.mjs";

const GROUP_ID = "-1001234567890";

function tempDir() {
  return mkdtempSync(path.join(tmpdir(), "openclaw-topic-cron-"));
}

function registry(groupId = GROUP_ID, title = "Example Forum") {
  return {
    groupId,
    title,
    isForum: true,
    onboardingStatus: "active",
    topics: {
      "1": { title: "General", agentId: "general" },
    },
    updatedAt: "2026-05-25T07:00:00.000Z",
  };
}

test("safeGroupId creates stable cron-safe group ids", () => {
  assert.equal(safeGroupId("-1001234567890"), "1001234567890");
  assert.throws(() => safeGroupId("123"), /Invalid Telegram group id/);
});

test("buildCronSpec uses per-group stable name, session, delivery, and prompt", () => {
  const spec = buildCronSpec(registry(), {
    containerRegistryRoot: "/registry",
    cron: "15 8 * * *",
    tz: "UTC",
  });

  assert.equal(spec.name, "topic-intelligence-daily--1001234567890");
  assert.equal(spec.sessionKey, "agent:main:cron:topic-intelligence-daily:1001234567890");
  assert.equal(spec.cron, "15 8 * * *");
  assert.equal(spec.tz, "UTC");
  assert.equal(spec.to, GROUP_ID);
  assert.match(spec.message, /daily-audit-prompt\.md/);
  assert.match(spec.message, /Example Forum/);
  assert.match(spec.message, /\/registry\/-1001234567890\.json/);
});

test("buildCronMessage keeps external installs recommend-only", () => {
  const message = buildCronMessage(registry());
  assert.match(message, /localSkillsCreated\/localSkillsUpdated/);
  assert.match(message, /Do not install external plugins; recommend only\./);
});

test("planCronInstalls detects existing jobs by name", () => {
  const jobs = planCronInstalls(
    [registry()],
    [{ name: "topic-intelligence-daily--1001234567890" }],
  );
  assert.equal(jobs[0].action, "exists");
  assert.equal(jobs[0].wouldChange, false);
});

test("readGroupRegistries reads active group files and skips index/inactive registries", () => {
  const dir = tempDir();
  try {
    writeRegistryForTest(dir, registry());
    writeRegistryForTest(dir, { ...registry("-1002222222222", "Inactive"), onboardingStatus: "disabled" });
    writeFileSync(path.join(dir, "index.json"), "{}\n", "utf8");

    const registries = readGroupRegistries(dir, { all: true });
    assert.equal(registries.length, 1);
    assert.equal(registries[0].groupId, GROUP_ID);
    assert.match(registries[0].registryPath, /-1001234567890\.json$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runInstall dry-run plans without adding jobs", async () => {
  const dir = tempDir();
  try {
    writeRegistryForTest(dir, registry());
    let addCalls = 0;
    const result = await runInstall({
      dryRun: true,
      apply: false,
      all: true,
      registryRoot: dir,
      listCronJobs: () => [],
      addCronJob: () => {
        addCalls++;
      },
    });

    assert.equal(result.mode, "dry-run");
    assert.equal(result.totalRegistries, 1);
    assert.equal(result.jobs[0].action, "add");
    assert.equal(result.addedCount, 0);
    assert.equal(addCalls, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runInstall apply is idempotent and only adds missing jobs", async () => {
  const dir = tempDir();
  try {
    writeRegistryForTest(dir, registry());
    const added = [];
    const result = await runInstall({
      dryRun: false,
      apply: true,
      all: true,
      registryRoot: dir,
      listCronJobs: () => [],
      addCronJob: (spec) => {
        added.push(spec.name);
        return { ok: true, id: "job-1" };
      },
    });

    assert.deepEqual(added, ["topic-intelligence-daily--1001234567890"]);
    assert.equal(result.addedCount, 1);

    const second = await runInstall({
      dryRun: false,
      apply: true,
      all: true,
      registryRoot: dir,
      listCronJobs: () => [{ name: "topic-intelligence-daily--1001234567890" }],
      addCronJob: () => {
        throw new Error("should not add duplicate");
      },
    });
    assert.equal(second.jobs[0].action, "exists");
    assert.equal(second.addedCount, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
