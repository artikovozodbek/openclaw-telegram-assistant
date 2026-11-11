"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  normalizeBotApiGroupId,
  normalizeForumTopic,
  normalizeForumTopicsResult,
  publicForumTopicError,
  selectForumGroupDialog,
} = require("./tg-watcher-forum-topics");

test("normalizeBotApiGroupId accepts Bot API supergroup ids", () => {
  assert.deepEqual(normalizeBotApiGroupId("-1001234567890"), {
    groupId: "-1001234567890",
    peerId: "1234567890",
  });
});

test("normalizeBotApiGroupId rejects missing or non-supergroup ids", () => {
  assert.throws(() => normalizeBotApiGroupId(""), /groupId required/);
  assert.throws(() => normalizeBotApiGroupId("1234567890"), /-100/);
  assert.throws(() => normalizeBotApiGroupId("-1234567890"), /-100/);
});

test("normalizeForumTopic exposes only safe forum topic fields", () => {
  assert.deepEqual(
    normalizeForumTopic({
      className: "ForumTopic",
      id: 4,
      title: " Google Workspace ",
      closed: false,
      hidden: true,
      topMessage: 123,
      draft: { message: "private draft" },
    }),
    {
      id: "4",
      title: "Google Workspace",
      closed: false,
      hidden: true,
      topMessage: "123",
    },
  );
});

test("normalizeForumTopicsResult filters deleted and unknown topic records", () => {
  const result = normalizeForumTopicsResult(
    {
      count: 3,
      topics: [
        { className: "ForumTopic", id: 1, title: "General", topMessage: 11 },
        { className: "ForumTopicDeleted", id: 2 },
        { className: "SomethingElse", id: 3, title: "Bad" },
      ],
    },
    {
      groupId: "-1001234567890",
      peerId: "1234567890",
      title: "Test Group For Openclaw",
    },
  );

  assert.equal(result.count, 1);
  assert.equal(result.total, 3);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.topics, [
    {
      id: "1",
      title: "General",
      closed: false,
      hidden: false,
      topMessage: "11",
    },
  ]);
});

test("selectForumGroupDialog chooses matching Channel megagroup by peer id", () => {
  const channelEntry = {
    info: { peerId: "1234567890", kind: "group" },
    dialog: { entity: { className: "Channel", megagroup: true, title: "Forum" } },
  };
  const entries = [
    {
      info: { peerId: "5159898225", kind: "group" },
      dialog: { entity: { className: "Chat", title: "Migrated old group" } },
    },
    channelEntry,
  ];

  assert.equal(selectForumGroupDialog(entries, "1234567890"), channelEntry);
  assert.equal(selectForumGroupDialog(entries, "5159898225"), null);
});

test("publicForumTopicError maps common Telegram errors to safe messages", () => {
  assert.deepEqual(
    {
      status: publicForumTopicError({ errorMessage: "CHANNEL_PRIVATE" }).status,
      message: publicForumTopicError({ errorMessage: "CHANNEL_PRIVATE" }).message,
    },
    { status: 404, message: "group is not visible to the MTProto user" },
  );

  assert.deepEqual(
    {
      status: publicForumTopicError({ errorMessage: "CHAT_FORUM_MISSING" }).status,
      message: publicForumTopicError({ errorMessage: "CHAT_FORUM_MISSING" }).message,
    },
    { status: 400, message: "group is not forum-enabled or topics are unavailable" },
  );
});
