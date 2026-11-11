import assert from "node:assert/strict";
import test from "node:test";

import {
  validateRegistry,
  validateRoutePlan,
} from "./test-topic-onboarding.mjs";

test("validateRoutePlan accepts dedicated general, google workspace, and adaptive unknown routes", () => {
  assert.equal(
    validateRoutePlan([
      {
        topicId: "1",
        title: "General",
        agentId: "topic_1001234567890_1",
        routingMode: "topic_profile",
        domainRoutingMode: "static",
        existingAgentId: null,
        action: "add",
        requireMention: true,
      },
      {
        topicId: "4",
        title: "Google Workspace",
        agentId: "topic_1001234567890_4",
        routingMode: "topic_profile",
        domainRoutingMode: "static",
        skills: ["telegram", "topic-intelligence", "gws-gmail"],
        existingAgentId: null,
        action: "add",
        requireMention: true,
      },
      {
        topicId: "27",
        title: "Education",
        agentId: "topic_1001234567890_27",
        routingMode: "topic_profile",
        domainRoutingMode: "adaptive",
        existingAgentId: null,
        action: "add",
        requireMention: true,
      },
    ], { requireExistingPreserved: true }),
    true,
  );
});

test("validateRoutePlan rejects unsafe or incorrect routes", () => {
  assert.throws(
    () => validateRoutePlan([
      {
        topicId: "4",
        title: "Google Workspace",
        agentId: "general",
        routingMode: "topic_profile",
        domainRoutingMode: "adaptive",
        existingAgentId: null,
        action: "add",
        requireMention: true,
      },
    ]),
    /dedicated topic agent/,
  );

  assert.throws(
    () => validateRoutePlan([
      {
        topicId: "27",
        title: "Education",
        agentId: "general",
        routingMode: "adaptive",
        existingAgentId: null,
        action: "add",
        requireMention: false,
      },
    ]),
    /mention-gated/,
  );
});

test("validateRegistry requires active forum registry with topics", () => {
  assert.equal(
    validateRegistry({
      groupId: "-1001234567890",
      isForum: true,
      onboardingStatus: "active",
      topics: {
        "1": { title: "General" },
      },
    }, "-1001234567890"),
    true,
  );

  assert.throws(
    () => validateRegistry({
      groupId: "-1001234567890",
      isForum: false,
      onboardingStatus: "active",
      topics: {},
    }, "-1001234567890"),
    /forum-enabled/,
  );
});
