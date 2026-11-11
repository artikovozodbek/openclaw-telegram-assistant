"use strict";

function cleanText(value) {
  return String(value || "").trim();
}

function publicError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeBotApiGroupId(value) {
  const groupId = cleanText(value);
  if (!groupId) throw publicError(400, "groupId required");
  if (!/^-100\d+$/.test(groupId)) {
    throw publicError(400, "groupId must use Telegram Bot API supergroup format (-100...)");
  }
  return {
    groupId,
    peerId: groupId.slice(4),
  };
}

function entityClassName(entity) {
  return cleanText(entity?.className || entity?.constructor?.name);
}

function isForumCapableGroupEntry(entry, peerId) {
  const entity = entry?.dialog?.entity || {};
  const info = entry?.info || {};
  if (String(info.peerId || "") !== String(peerId)) return false;
  if (entityClassName(entity) !== "Channel") return false;
  if (entity.broadcast === true) return false;
  return info.kind === "group" || entity.megagroup === true || entity.gigagroup === true;
}

function selectForumGroupDialog(entries, peerId) {
  for (const entry of entries || []) {
    if (isForumCapableGroupEntry(entry, peerId)) return entry;
  }
  return null;
}

function valueToString(value) {
  if (value === null || value === undefined) return null;
  return String(value);
}

function normalizeForumTopic(topic) {
  const className = entityClassName(topic);
  if (className === "ForumTopicDeleted") return null;
  if (className && className !== "ForumTopic") return null;

  const id = valueToString(topic?.id);
  if (!id) return null;

  return {
    id,
    title: cleanText(topic?.title),
    closed: topic?.closed === true,
    hidden: topic?.hidden === true,
    topMessage: valueToString(topic?.topMessage ?? topic?.top_message),
  };
}

function normalizeForumTopicsResult(result, context) {
  const topics = Array.isArray(result?.topics)
    ? result.topics.map(normalizeForumTopic).filter(Boolean)
    : [];
  const rawTotal = Number.isFinite(Number(result?.count)) ? Number(result.count) : topics.length;
  const total = Math.max(rawTotal, topics.length);

  return {
    ok: true,
    groupId: context.groupId,
    peerId: context.peerId,
    title: cleanText(context.title),
    isForum: true,
    count: topics.length,
    total,
    truncated: total > topics.length,
    topics,
  };
}

function publicForumTopicError(error) {
  const raw = cleanText(error?.errorMessage || error?.message || "");
  const upper = raw.toUpperCase();

  if (
    upper.includes("CHANNEL_PRIVATE") ||
    upper.includes("USER_NOT_PARTICIPANT") ||
    upper.includes("PEER_ID_INVALID") ||
    upper.includes("CHANNEL_INVALID")
  ) {
    return publicError(404, "group is not visible to the MTProto user");
  }

  if (
    upper.includes("CHAT_FORUM_MISSING") ||
    upper.includes("FORUM_TOPIC") ||
    upper.includes("TOPIC")
  ) {
    return publicError(400, "group is not forum-enabled or topics are unavailable");
  }

  return publicError(500, "forum topic discovery failed");
}

module.exports = {
  normalizeBotApiGroupId,
  normalizeForumTopic,
  normalizeForumTopicsResult,
  publicError,
  publicForumTopicError,
  selectForumGroupDialog,
};
