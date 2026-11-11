import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildCronMessage,
  buildCronSpec,
  planCronInstalls,
  runInstall,
  safeGroupId,
  writeRegistryForTest,
} from "./install-telegram-topic-onboarding-cron.mjs";

const GROUP_ID = "-1001234567890";

function tempDir() {
  return mkdtempSync(path.join(tmpdir(), "openclaw-topic-reonboard-cron-"));
}

function registry(groupId = GROUP_ID, title = "Example Forum") {
  return {
    groupId,
    title,
    isForum: true,
    onboardingStatus: "active",
    topics: {},
  };
}

test("safeGroupId creates stable cron-safe group ids", () => {
  assert.equal(safeGroupId(GROUP_ID), "1001234567890");
  assert.throws(() => safeGroupId("123"), /Invalid Telegram group id/);
});

test("buildCronSpec uses six-hour onboarding schedule and stable identity", () => {
  const spec = buildCronSpec(registry(), {
    agent: "main",
    tz: "Asia/Tashkent",
  });

  assert.equal(spec.name, "telegram-topic-onboarding--1001234567890");
  assert.equal(spec.sessionKey, "agent:main:cron:telegram-topic-onboarding:1001234567890");
  assert.equal(spec.cron, "0 */6 * * *");
  assert.equal(spec.tz, "Asia/Tashkent");
  assert.equal(spec.timeoutMs, 120000);
});

test("buildCronMessage runs mounted container onboarding command and avoids installs", () => {
  const message = buildCronMessage(registry());
  assert.match(message, /workspace\/bin\/telegram-topic-onboard\.mjs --group -1001234567890 --apply/);
  assert.match(message, /workspace\/bin\/topic-agent-allowlists\.mjs --registry/);
  assert.match(message, /Do not inspect or print secrets/);
  assert.match(message, /Do not install external plugins or packages/);
});

test("planCronInstalls detects existing jobs by name", () => {
  const jobs = planCronInstalls(
    [registry()],
    [{ name: "telegram-topic-onboarding--1001234567890" }],
  );

  assert.equal(jobs[0].action, "exists");
  assert.equal(jobs[0].wouldChange, false);
});

test("runInstall dry-run reads active registries and skips inactive ones", async () => {
  const dir = tempDir();
  try {
    writeRegistryForTest(dir, registry());
    writeRegistryForTest(dir, { ...registry("-1002222222222", "Inactive"), onboardingStatus: "disabled" });

    const result = await runInstall({
      dryRun: true,
      apply: false,
      all: true,
      registryRoot: dir,
      listCronJobs: () => [],
    });

    assert.equal(result.mode, "dry-run");
    assert.equal(result.totalRegistries, 1);
    assert.equal(result.jobs.length, 1);
    assert.equal(result.jobs[0].action, "add");
    assert.equal(result.addedCount, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runInstall apply is idempotent and only adds missing jobs", async () => {
  const added = [];
  const dir = tempDir();
  try {
    writeRegistryForTest(dir, registry());
    const first = await runInstall({
      dryRun: false,
      apply: true,
      all: true,
      registryRoot: dir,
      listCronJobs: () => [],
      addCronJob: (spec) => {
        added.push(spec.name);
        return { ok: true };
      },
    });

    assert.equal(first.addedCount, 1);
    assert.deepEqual(added, ["telegram-topic-onboarding--1001234567890"]);

    const second = await runInstall({
      dryRun: false,
      apply: true,
      all: true,
      registryRoot: dir,
      listCronJobs: () => [{ name: "telegram-topic-onboarding--1001234567890" }],
      addCronJob: () => {
        throw new Error("should not add existing cron job");
      },
    });

    assert.equal(second.addedCount, 0);
    assert.equal(second.jobs[0].action, "exists");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
