"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  extractInstruction,
  makeSeenSet,
  classifyReadResult,
} = require("./tg-watcher-direct");

test("extractInstruction preserves the original case of the instruction", () => {
  assert.equal(
    extractInstruction("jarvis write in my Saved Messages: Meeting at 10:00", "jarvis"),
    "write in my Saved Messages: Meeting at 10:00"
  );
});

test("extractInstruction matches the trigger case-insensitively", () => {
  assert.equal(extractInstruction("JARVIS read my chat with Alirizo", "jarvis"), "read my chat with Alirizo");
  assert.equal(extractInstruction("Jarvis, read my chat", "jarvis"), "read my chat");
});

test("extractInstruction strips leading separators", () => {
  assert.equal(extractInstruction("jarvis: do X", "jarvis"), "do X");
  assert.equal(extractInstruction("jarvis - do X", "jarvis"), "do X");
  assert.equal(extractInstruction("jarvis — do X", "jarvis"), "do X");
});

test("extractInstruction handles a mid-sentence trigger", () => {
  assert.equal(extractInstruction("hey jarvis summarize Alirizo", "jarvis"), "hey  summarize Alirizo".replace(/^\s+/, ""));
});

test("extractInstruction returns empty when only the trigger is present", () => {
  assert.equal(extractInstruction("jarvis", "jarvis"), "");
  assert.equal(extractInstruction("  jarvis  ", "jarvis"), "");
});

test("extractInstruction tolerates empty and non-string input", () => {
  assert.equal(extractInstruction("", "jarvis"), "");
  assert.equal(extractInstruction(null, "jarvis"), "");
  assert.equal(extractInstruction(undefined, "jarvis"), "");
});

test("extractInstruction preserves non-Latin text", () => {
  assert.equal(extractInstruction("jarvis напиши в избранное: встреча в 10", "jarvis"), "напиши в избранное: встреча в 10");
  assert.equal(extractInstruction("jarvis o'zimga yoz: ertaga uchrashuv", "jarvis"), "o'zimga yoz: ertaga uchrashuv");
});

test("makeSeenSet dedups repeated update ids", () => {
  const seen = makeSeenSet(10);
  assert.equal(seen.has("chat:1"), false);
  seen.remember("chat:1");
  assert.equal(seen.has("chat:1"), true);
  seen.remember("chat:1");
  assert.equal(seen.size(), 1, "re-remembering must not grow the set");
});

test("makeSeenSet evicts oldest entries beyond the cap", () => {
  const seen = makeSeenSet(3);
  seen.remember("a");
  seen.remember("b");
  seen.remember("c");
  seen.remember("d");
  assert.equal(seen.size(), 3);
  assert.equal(seen.has("a"), false, "oldest evicted");
  assert.equal(seen.has("d"), true, "newest retained");
});

test("classifyReadResult flags ambiguous matches so the agent asks", () => {
  assert.equal(
    classifyReadResult({ ok: false, error: 'ambiguous dialog match for "Bootcamp"', matches: [{}, {}] }),
    "ambiguous"
  );
});

test("classifyReadResult flags a missing dialog", () => {
  assert.equal(classifyReadResult({ ok: false, error: 'no existing dialog matched "Nobody"' }), "not_found");
});

test("classifyReadResult flags an empty history rather than inviting invention", () => {
  assert.equal(classifyReadResult({ ok: true, messages: [] }), "empty");
});

test("classifyReadResult accepts a real result", () => {
  assert.equal(classifyReadResult({ ok: true, messages: [{ text: "hi" }] }), "ok");
});

test("classifyReadResult treats malformed input as not_found", () => {
  assert.equal(classifyReadResult(null), "not_found");
  assert.equal(classifyReadResult(undefined), "not_found");
  assert.equal(classifyReadResult("nonsense"), "not_found");
});
