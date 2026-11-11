#!/usr/bin/env node
/**
 * PM Reports Skill - CLI Script
 * Generate PM reports - daily, full, analytics
 *
 * Usage:
 *   report daily
 *   report full
 *   report analytics
 */

const fs = require('fs');
const path = require('path');
const { loadDevelopers, getActiveTracker, getPrimaryTrackerId } = require('../../shared/developerData');
const { buildConfig, getBoardLists, getBoardCustomFields, getBoardCards, normalizeCard } = require('../../pm-trello/scripts/trello');

// Load environment variables
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });

// Configuration from environment
const config = {
  jira: {
    baseUrl: process.env.JIRA_URL,
    username: process.env.JIRA_USERNAME,
    password: process.env.JIRA_PASSWORD,
    projectKey: process.env.JIRA_PROJECT_KEY,
    storyPointsField: process.env.JIRA_STORY_POINTS_FIELD || 'customfield_10107'
  },
  brain: {
    baseUrl: process.env.BRAIN_URL,
    apiKey: process.env.BRAIN_API_KEY,
    basicAuthUser: process.env.BRAIN_BASIC_AUTH_USER,
    basicAuthPass: process.env.BRAIN_BASIC_AUTH_PASS
  },
  llm: {
    baseUrl: process.env.LLM_BASE_URL,
    apiKey: process.env.LLM_API_KEY,
    model: process.env.LLM_MODEL
  }
};

// Data paths
const reportsDir = path.join(__dirname, '../../../agents/default/data');

// Auth headers
const jiraAuth = 'Basic ' + Buffer.from(`${config.jira.username}:${config.jira.password}`).toString('base64');
const brainHeaders = {
  'X-API-Key': config.brain.apiKey,
  'Authorization': 'Basic ' + Buffer.from(`${config.brain.basicAuthUser}:${config.brain.basicAuthPass}`).toString('base64'),
  'Content-Type': 'application/json'
};

/**
 * Execute JIRA search
 */
async function jiraSearch(jql) {
  const allIssues = [];
  let startAt = 0;
  const batchSize = 100;
  let total = 0;

  do {
    const response = await fetch(`${config.jira.baseUrl}/rest/api/2/search`, {
      method: 'POST',
      headers: {
        'Authorization': jiraAuth,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        jql,
        fields: ['key', 'summary', 'assignee', 'status', 'duedate', 'created', config.jira.storyPointsField],
        startAt,
        maxResults: batchSize
      })
    });

    if (!response.ok) {
      throw new Error(`JIRA search failed: ${response.status}`);
    }

    const data = await response.json();
    total = data.total;

    const issues = data.issues.map(issue => ({
      key: issue.key,
      summary: issue.fields.summary,
      assignee: issue.fields.assignee?.name || null,
      status: issue.fields.status?.name || null,
      duedate: issue.fields.duedate,
      created: issue.fields.created,
      storyPoints: issue.fields[config.jira.storyPointsField] || 3
    }));

    allIssues.push(...issues);
    startAt += batchSize;
  } while (startAt < total);

  return allIssues;
}

/**
 * Query Brain
 */
async function brainQuery(question) {
  try {
    const response = await fetch(`${config.brain.baseUrl}/query`, {
      method: 'POST',
      headers: brainHeaders,
      body: JSON.stringify({ question, mode: 'hybrid' })
    });

    if (!response.ok) return 'No context found';

    const data = await response.json();
    return data.result || data.response || 'No context found';
  } catch (e) {
    return 'Brain query failed';
  }
}

/**
 * Group issues by assignee
 */
function groupByAssignee(issues) {
  const grouped = {};
  for (const issue of issues) {
    const assignee = issue.assignee || 'Unassigned';
    if (!grouped[assignee]) grouped[assignee] = [];
    grouped[assignee].push(issue);
  }
  return grouped;
}

/**
 * Calculate total SP
 */
function calculateTotalSP(issues) {
  return issues.reduce((sum, i) => sum + (i.storyPoints || 3), 0);
}

function calculateTrelloTotalSP(cards) {
  return cards.reduce((sum, card) => sum + (typeof card.storyPoints === 'number' ? card.storyPoints : 0), 0);
}

function isTrelloDone(card, trelloConfig) {
  return Boolean(trelloConfig.doneListId && card.listId === trelloConfig.doneListId);
}

function isTrelloWip(card, trelloConfig) {
  return trelloConfig.wipListIds.includes(card.listId);
}

function isTrelloOverdue(card, trelloConfig) {
  if (isTrelloDone(card, trelloConfig)) return false;
  if (!card.duedate) return false;
  return card.duedate < new Date().toISOString().slice(0, 10);
}

async function loadTrelloSnapshot() {
  const trelloConfig = buildConfig();
  const boardId = trelloConfig.boardId;
  const [lists, customFields, cards] = await Promise.all([
    getBoardLists(boardId, trelloConfig),
    getBoardCustomFields(boardId, trelloConfig),
    getBoardCards(boardId, trelloConfig)
  ]);

  const listLookup = new Map(lists.map(list => [list.id, list]));
  const customFieldLookup = new Map(customFields.map(field => [field.id, field]));
  const normalizedCards = cards.map(card =>
    normalizeCard(card, { config: trelloConfig, listLookup, customFieldLookup })
  );

  return {
    boardId,
    boardName: process.env.TRELLO_BOARD_NAME || process.env.TRELLO_BOARD_ID,
    trelloConfig,
    cards: normalizedCards
  };
}

function getMappedTrelloDevelopers() {
  return loadDevelopers().filter(dev => getPrimaryTrackerId(dev, getActiveTracker()) !== null);
}

function buildTrelloPerDevBuckets(devs) {
  const perDevData = {};
  for (const dev of devs) {
    const trackerId = getPrimaryTrackerId(dev, 'trello');
    perDevData[trackerId] = {
      name: dev.name,
      trello_id: dev.trello_id || null,
      trello_username: dev.trello_username || null,
      position: dev.position,
      level: dev.level,
      capacity: dev.capacity_sp_per_week,
      done: [],
      inProgress: [],
      overdue: [],
      openAssigned: []
    };
  }
  return perDevData;
}

function assignTrelloCardsToDevelopers(perDevData, cards, trelloConfig) {
  for (const card of cards) {
    for (const memberId of card.memberIds || []) {
      const bucket = perDevData[memberId];
      if (!bucket) continue;

      if (isTrelloDone(card, trelloConfig)) {
        bucket.done.push(card);
      } else {
        bucket.openAssigned.push(card);
        if (isTrelloWip(card, trelloConfig)) {
          bucket.inProgress.push(card);
        }
        if (isTrelloOverdue(card, trelloConfig)) {
          bucket.overdue.push(card);
        }
      }
    }
  }
}

/**
 * Call LLM to generate report
 */
async function generateWithLLM(systemPrompt, contextData) {
  const promptJson = JSON.stringify(contextData, null, 2);
  // Rough local estimate (not tokenizer-accurate; for quick diagnostics only)
  // Kept behind a debug flag to avoid leaking/printing usage-like info in normal runs.
  if (process.env.PM_REPORTS_DEBUG === '1') {
    const approxInTokens = Math.ceil((systemPrompt.length + promptJson.length) / 4);
    console.log(`[LLM] approx input chars=${systemPrompt.length + promptJson.length}, approx tokens≈${approxInTokens}`);
  }
  const response = await fetch(`${config.llm.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.llm.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: config.llm.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: JSON.stringify(contextData, null, 2) }
      ],
      max_tokens: 6000,
      temperature: 0.3
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`LLM API error: ${response.status} - ${error}`);
  }

  const data = await response.json();

  // Best-effort usage logging (depends on provider compatibility)
  // OpenAI-style: data.usage = { prompt_tokens, completion_tokens, total_tokens }
  // Disabled by default to avoid printing usage-like footers/logs.
  if (process.env.PM_REPORTS_DEBUG === '1' && data?.usage) {
    console.log('[LLM] usage:', JSON.stringify(data.usage));
  }

  return data.choices[0].message.content;
}

// ============================================================================
// DAILY REPORT
// ============================================================================

const DAILY_PROMPT = `You are a PM Report Agent. Generate a concise Daily Status Report.

INPUT: JSON with projectKey, today, developers, jiraData (completedToday, inProgress, overdue, openAssigned), brainContext

OUTPUT FORMAT (text only, no markdown):
📊 DAILY REPORT | {Date} | Project: {KEY}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

PER DEVELOPER (sorted by health - critical first):
👤 {NAME} | Load: {X}% | Health: {emoji}
├─ ✅ Completed: {N} tasks ({SP} SP)
├─ 🔄 In Progress: {N} tasks
├─ ⚠️ At Risk: {list if any}
└─ ❌ Overdue: {list if any}

📊 TEAM SUMMARY
Total Completed Today: {N} tasks ({SP} SP)
Currently In Progress: {N} tasks
Overdue: {N} tasks
Team Load Average: {X}%

🔴 ALERTS (if any)
🟡 WARNINGS (if any)
💡 HIGHLIGHTS

Health: 🟢=Good/Excellent, 🟡=Moderate, 🔴=Critical
Load = inProgress_sp / capacity_sp_per_week * 100`;

async function generateDailyReport() {
  console.log('[DAILY] Starting report generation...');
  const devs = loadDevelopers();
  const projectKey = config.jira.projectKey;
  const today = new Date().toISOString().split('T')[0];

  // JIRA queries
  console.log('[DAILY] Executing JIRA queries...');
  const [completedToday, inProgress, overdue, openAssigned] = await Promise.all([
    jiraSearch(`project = ${projectKey} AND statusCategory = Done AND updated >= "${today}"`),
    jiraSearch(`project = ${projectKey} AND statusCategory = "In Progress"`),
    jiraSearch(`project = ${projectKey} AND duedate < now() AND statusCategory != Done`),
    jiraSearch(`project = ${projectKey} AND assignee is not EMPTY AND statusCategory != Done`)
  ]);

  // Brain queries
  console.log('[DAILY] Querying Brain...');
  const [priorities, patterns, issues] = await Promise.all([
    brainQuery(`What are current PM priorities for project ${projectKey}?`),
    brainQuery(`Any developer performance patterns or concerns?`),
    brainQuery(`What issues were flagged in recent daily reports?`)
  ]);

  // Aggregate by developer
  const perDevData = {};
  for (const dev of devs) {
    perDevData[dev.jira_id] = {
      name: dev.name,
      position: dev.position,
      level: dev.level,
      capacity: dev.capacity_sp_per_week,
      completedToday: [],
      inProgress: [],
      overdue: [],
      openAssigned: []
    };
  }

  for (const issue of completedToday) {
    if (perDevData[issue.assignee]) perDevData[issue.assignee].completedToday.push(issue);
  }
  for (const issue of inProgress) {
    if (perDevData[issue.assignee]) perDevData[issue.assignee].inProgress.push(issue);
  }
  for (const issue of overdue) {
    if (perDevData[issue.assignee]) perDevData[issue.assignee].overdue.push(issue);
  }
  for (const issue of openAssigned) {
    if (perDevData[issue.assignee]) perDevData[issue.assignee].openAssigned.push(issue);
  }

  // Generate report
  console.log('[DAILY] Generating report via LLM...');
  const contextData = {
    projectKey,
    today: new Date().toLocaleString('en-GB', { timeZone: 'Asia/Tashkent', dateStyle: 'full' }),
    developers: devs.map(d => ({ name: d.name, jira_id: d.jira_id, position: d.position, level: d.level, capacity_sp_per_week: d.capacity_sp_per_week })),
    jiraData: perDevData,
    brainContext: { priorities, patterns, issues }
  };

  const report = await generateWithLLM(DAILY_PROMPT, contextData);

  // Save report
  const reportPath = path.join(reportsDir, 'latest-daily-report.txt');
  fs.writeFileSync(reportPath, report);
  console.log(`[DAILY] Report saved to ${reportPath}`);

  return report;
}

// ============================================================================
// FULL REPORT
// ============================================================================

const FULL_PROMPT = `You are a PM Report Agent. Generate a comprehensive Developer Profiles Report.

INPUT: JSON with projectKey, today, developers, jiraData (last30Days, allTime, currentAssigned per developer), brainContext

OUTPUT FORMAT (text only):
📈 FULL DEVELOPER REPORT | {Date}
Project: {KEY}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

For EACH developer:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 {NAME} | {POSITION} | Level {X}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 Performance Score: {X}/100
📈 Velocity: {X} SP/week (capacity: {Y})
⏱️ On-Time Rate: {X}%

Current Load:
├─ Open Issues: {N} ({SP} SP)
├─ In Progress: {N}
└─ Utilization: {X}%

Last 30 Days:
├─ Completed: {N} tasks ({SP} SP)
└─ Avg Completion Time: {X} days

Strengths: {list}
Areas for Growth: {list}
Recommendations: {actionable items}

TEAM OVERVIEW
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Total Active Developers: {N}
Average Performance Score: {X}/100
Total Capacity: {X} SP/week
Current Utilization: {X}%

Rankings by Performance:
1. {Developer} - {score}/100
2. ...`;

async function generateFullReport() {
  console.log('[FULL] Starting report generation...');
  const devs = loadDevelopers();
  const projectKey = config.jira.projectKey;

  // JIRA queries
  console.log('[FULL] Executing JIRA queries...');
  const [last30Days, allTime, currentAssigned] = await Promise.all([
    jiraSearch(`project = ${projectKey} AND updated >= -30d`),
    jiraSearch(`project = ${projectKey} AND statusCategory = Done`),
    jiraSearch(`project = ${projectKey} AND assignee is not EMPTY AND statusCategory != Done`)
  ]);

  // Brain queries
  console.log('[FULL] Querying Brain...');
  const [velocity, lessons, strategic] = await Promise.all([
    brainQuery(`Historical velocity patterns for project ${projectKey}?`),
    brainQuery(`Lessons learned from past sprints?`),
    brainQuery(`Strategic context for developer evaluations?`)
  ]);

  // Aggregate by developer
  const perDevData = {};
  for (const dev of devs) {
    perDevData[dev.jira_id] = {
      name: dev.name,
      position: dev.position,
      level: dev.level,
      capacity: dev.capacity_sp_per_week,
      last30Days: [],
      allTime: [],
      currentAssigned: []
    };
  }

  for (const issue of last30Days) {
    if (perDevData[issue.assignee]) perDevData[issue.assignee].last30Days.push(issue);
  }
  for (const issue of allTime) {
    if (perDevData[issue.assignee]) perDevData[issue.assignee].allTime.push(issue);
  }
  for (const issue of currentAssigned) {
    if (perDevData[issue.assignee]) perDevData[issue.assignee].currentAssigned.push(issue);
  }

  // Generate report
  console.log('[FULL] Generating report via LLM...');
  const contextData = {
    projectKey,
    today: new Date().toLocaleString('en-GB', { timeZone: 'Asia/Tashkent', dateStyle: 'full' }),
    developers: devs.map(d => ({ name: d.name, jira_id: d.jira_id, position: d.position, level: d.level, capacity_sp_per_week: d.capacity_sp_per_week })),
    jiraData: perDevData,
    brainContext: { velocity, lessons, strategic }
  };

  const report = await generateWithLLM(FULL_PROMPT, contextData);

  // Save report
  const reportPath = path.join(reportsDir, 'latest-full-report.txt');
  fs.writeFileSync(reportPath, report);
  console.log(`[FULL] Report saved to ${reportPath}`);

  return report;
}

// ============================================================================
// ANALYTICS REPORT
// ============================================================================

const ANALYTICS_PROMPT = `You are a PM Report Agent. Generate a Strategic Analytics Report.

INPUT: JSON with projectKey, today, developers, teamTotals (thisWeek, lastWeek, thisMonth, lastMonth, wip), jiraData per developer, brainContext

OUTPUT FORMAT (text only):
📉 ANALYTICS REPORT | {Date}
Project: {KEY}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📊 VELOCITY TRENDS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
This Week: {N} tasks ({SP} SP)
Last Week: {N} tasks ({SP} SP)
Change: {+/-X}%

This Month: {N} tasks ({SP} SP)
Last Month: {N} tasks ({SP} SP)
Change: {+/-X}%

📈 CAPACITY ANALYSIS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Team Capacity: {X} SP/week
Current WIP: {N} tasks ({SP} SP)
Utilization: {X}%
Forecast: {prediction for next week}

⚠️ RISK ASSESSMENT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
{List of identified risks with severity}

🎯 STRATEGIC RECOMMENDATIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. {Recommendation with reasoning}
2. ...

📅 PREDICTIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Next week velocity estimate: {X} SP
- Capacity concerns: {if any}
- Recommended focus areas: {list}`;

async function generateAnalyticsReport() {
  console.log('[ANALYTICS] Starting report generation...');
  const devs = loadDevelopers();
  const projectKey = config.jira.projectKey;

  // JIRA queries
  console.log('[ANALYTICS] Executing JIRA queries...');
  const [thisWeek, lastWeek, thisMonth, lastMonth, wip] = await Promise.all([
    jiraSearch(`project = ${projectKey} AND statusCategory = Done AND updated >= startOfWeek()`),
    jiraSearch(`project = ${projectKey} AND statusCategory = Done AND updated >= startOfWeek(-1w) AND updated < startOfWeek()`),
    jiraSearch(`project = ${projectKey} AND statusCategory = Done AND updated >= startOfMonth()`),
    jiraSearch(`project = ${projectKey} AND statusCategory = Done AND updated >= startOfMonth(-1M) AND updated < startOfMonth()`),
    jiraSearch(`project = ${projectKey} AND statusCategory = "In Progress"`)
  ]);

  // Brain queries
  console.log('[ANALYTICS] Querying Brain...');
  const [lastReport, predictions, patterns, strategic] = await Promise.all([
    brainQuery(`Get the last analytics report for project ${projectKey}`),
    brainQuery(`What predictions were made in previous reports? Were they accurate?`),
    brainQuery(`What patterns have emerged in team velocity and capacity?`),
    brainQuery(`What strategic context should inform this week's analytics?`)
  ]);

  // Calculate team totals
  const teamTotals = {
    thisWeek: { tasks: thisWeek.length, sp: calculateTotalSP(thisWeek) },
    lastWeek: { tasks: lastWeek.length, sp: calculateTotalSP(lastWeek) },
    thisMonth: { tasks: thisMonth.length, sp: calculateTotalSP(thisMonth) },
    lastMonth: { tasks: lastMonth.length, sp: calculateTotalSP(lastMonth) },
    wip: { tasks: wip.length, sp: calculateTotalSP(wip) }
  };

  // Aggregate by developer
  const perDevData = {};
  for (const dev of devs) {
    perDevData[dev.jira_id] = {
      name: dev.name,
      thisWeek: [],
      lastWeek: [],
      wip: []
    };
  }

  for (const issue of thisWeek) {
    if (perDevData[issue.assignee]) perDevData[issue.assignee].thisWeek.push(issue);
  }
  for (const issue of lastWeek) {
    if (perDevData[issue.assignee]) perDevData[issue.assignee].lastWeek.push(issue);
  }
  for (const issue of wip) {
    if (perDevData[issue.assignee]) perDevData[issue.assignee].wip.push(issue);
  }

  // Generate report
  console.log('[ANALYTICS] Generating report via LLM...');
  const contextData = {
    projectKey,
    today: new Date().toLocaleString('en-GB', { timeZone: 'Asia/Tashkent', dateStyle: 'full' }),
    developers: devs.map(d => ({ name: d.name, jira_id: d.jira_id, capacity_sp_per_week: d.capacity_sp_per_week })),
    teamTotals,
    jiraData: perDevData,
    brainContext: { lastReport, predictions, patterns, strategic }
  };

  const report = await generateWithLLM(ANALYTICS_PROMPT, contextData);

  // Save report
  const reportPath = path.join(reportsDir, 'latest-analytics-report.txt');
  fs.writeFileSync(reportPath, report);
  console.log(`[ANALYTICS] Report saved to ${reportPath}`);

  return report;
}

// ============================================================================
// TRELLO DAILY REPORT
// ============================================================================

const TRELLO_DAILY_PROMPT = `You are a PM Report Agent. Generate a concise Daily Status Report for a Trello board snapshot.

INPUT: JSON with boardName, today, developers, trelloData (done, inProgress, overdue, openAssigned per mapped developer), teamTotals, brainContext

IMPORTANT:
- This is a Trello snapshot, not historical workflow analytics.
- "Completed" means cards currently in the configured Done list.
- Do not invent daily completion history or past transitions.

OUTPUT FORMAT (text only, no markdown):
📊 DAILY REPORT | {Date} | Board: {NAME}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

PER DEVELOPER:
👤 {NAME} | Load: {X}% | Health: {emoji}
├─ ✅ Done Now: {N} cards ({SP} SP)
├─ 🔄 In Progress: {N} cards
├─ 📋 Open Assigned: {N} cards
└─ ❌ Overdue: {list if any}

📊 TEAM SUMMARY
Done Now: {N} cards ({SP} SP)
Currently In Progress: {N} cards ({SP} SP)
Open Assigned: {N} cards ({SP} SP)
Overdue: {N} cards

🔴 ALERTS
🟡 WARNINGS
💡 HIGHLIGHTS`;

async function generateTrelloDailyReport() {
  console.log('[TRELLO_DAILY] Starting report generation...');
  const devs = getMappedTrelloDevelopers();
  const snapshot = await loadTrelloSnapshot();
  const { trelloConfig, cards } = snapshot;

  console.log('[TRELLO_DAILY] Querying Brain...');
  const [priorities, patterns, issues] = await Promise.all([
    brainQuery(`What are current PM priorities for Trello board ${snapshot.boardId}?`),
    brainQuery('Any developer performance patterns or concerns?'),
    brainQuery('What issues were flagged in recent daily reports?')
  ]);

  const perDevData = buildTrelloPerDevBuckets(devs);
  assignTrelloCardsToDevelopers(perDevData, cards, trelloConfig);

  const doneCards = cards.filter(card => isTrelloDone(card, trelloConfig));
  const wipCards = cards.filter(card => isTrelloWip(card, trelloConfig) && !isTrelloDone(card, trelloConfig));
  const openCards = cards.filter(card => !isTrelloDone(card, trelloConfig));
  const overdueCards = cards.filter(card => isTrelloOverdue(card, trelloConfig));

  const contextData = {
    boardName: snapshot.boardName,
    today: new Date().toLocaleString('en-GB', { timeZone: 'Asia/Tashkent', dateStyle: 'full' }),
    developers: devs.map(d => ({
      name: d.name,
      trello_id: d.trello_id,
      trello_username: d.trello_username,
      position: d.position,
      level: d.level,
      capacity_sp_per_week: d.capacity_sp_per_week
    })),
    trelloData: perDevData,
    teamTotals: {
      done: { cards: doneCards.length, sp: calculateTrelloTotalSP(doneCards) },
      inProgress: { cards: wipCards.length, sp: calculateTrelloTotalSP(wipCards) },
      openAssigned: { cards: openCards.length, sp: calculateTrelloTotalSP(openCards) },
      overdue: { cards: overdueCards.length, sp: calculateTrelloTotalSP(overdueCards) }
    },
    brainContext: { priorities, patterns, issues }
  };

  const report = await generateWithLLM(TRELLO_DAILY_PROMPT, contextData);
  const reportPath = path.join(reportsDir, 'latest-trello-daily-report.txt');
  fs.writeFileSync(reportPath, report);
  console.log(`[TRELLO_DAILY] Report saved to ${reportPath}`);

  return report;
}

// ============================================================================
// TRELLO FULL REPORT
// ============================================================================

const TRELLO_FULL_PROMPT = `You are a PM Report Agent. Generate a comprehensive Developer Profiles Report for a Trello board snapshot.

INPUT: JSON with boardName, today, developers, trelloData (done, inProgress, overdue, openAssigned per mapped developer), teamTotals, brainContext

IMPORTANT:
- This is current Trello board state only.
- Do not invent historical velocity, completion time, or on-time rate metrics.
- Recommendations should be based on current assigned cards, WIP, overdue load, and SP distribution.

OUTPUT FORMAT (text only):
📈 FULL DEVELOPER REPORT | {Date}
Board: {NAME}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

For EACH developer:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 {NAME} | {POSITION} | Level {X}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Current Load:
├─ Open Assigned: {N} cards ({SP} SP)
├─ In Progress: {N} cards ({SP} SP)
├─ Done Now: {N} cards ({SP} SP)
└─ Overdue: {N} cards

Strengths: {list}
Areas for Growth: {list}
Recommendations: {actionable items}

TEAM OVERVIEW
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Mapped Developers: {N}
Total Capacity: {X} SP/week
Open Assigned: {N} cards ({SP} SP)
WIP: {N} cards ({SP} SP)
Done Now: {N} cards ({SP} SP)`;

async function generateTrelloFullReport() {
  console.log('[TRELLO_FULL] Starting report generation...');
  const devs = getMappedTrelloDevelopers();
  const snapshot = await loadTrelloSnapshot();
  const { trelloConfig, cards } = snapshot;

  console.log('[TRELLO_FULL] Querying Brain...');
  const [lessons, strategic, staffing] = await Promise.all([
    brainQuery('Lessons learned from past sprints?'),
    brainQuery('Strategic context for developer evaluations?'),
    brainQuery('Any staffing or workload concerns I should account for?')
  ]);

  const perDevData = buildTrelloPerDevBuckets(devs);
  assignTrelloCardsToDevelopers(perDevData, cards, trelloConfig);

  const doneCards = cards.filter(card => isTrelloDone(card, trelloConfig));
  const wipCards = cards.filter(card => isTrelloWip(card, trelloConfig) && !isTrelloDone(card, trelloConfig));
  const openCards = cards.filter(card => !isTrelloDone(card, trelloConfig));

  const contextData = {
    boardName: snapshot.boardName,
    today: new Date().toLocaleString('en-GB', { timeZone: 'Asia/Tashkent', dateStyle: 'full' }),
    developers: devs.map(d => ({
      name: d.name,
      trello_id: d.trello_id,
      trello_username: d.trello_username,
      position: d.position,
      level: d.level,
      capacity_sp_per_week: d.capacity_sp_per_week
    })),
    trelloData: perDevData,
    teamTotals: {
      mappedDevelopers: devs.length,
      totalCapacity: devs.reduce((sum, d) => sum + (d.capacity_sp_per_week || 0), 0),
      done: { cards: doneCards.length, sp: calculateTrelloTotalSP(doneCards) },
      inProgress: { cards: wipCards.length, sp: calculateTrelloTotalSP(wipCards) },
      openAssigned: { cards: openCards.length, sp: calculateTrelloTotalSP(openCards) }
    },
    brainContext: { lessons, strategic, staffing }
  };

  const report = await generateWithLLM(TRELLO_FULL_PROMPT, contextData);
  const reportPath = path.join(reportsDir, 'latest-trello-full-report.txt');
  fs.writeFileSync(reportPath, report);
  console.log(`[TRELLO_FULL] Report saved to ${reportPath}`);

  return report;
}

// ============================================================================
// TRELLO ANALYTICS REPORT
// ============================================================================

const TRELLO_ANALYTICS_PROMPT = `You are a PM Report Agent. Generate a strategic analytics report for the current Trello board state.

INPUT: JSON with boardName, today, developers, teamTotals, trelloData per mapped developer, brainContext

IMPORTANT:
- This is snapshot analysis, not historical trend analysis.
- Do not invent weekly or monthly throughput.
- Focus on current WIP, overdue risk, SP concentration, and workload balance.

OUTPUT FORMAT (text only):
📉 ANALYTICS REPORT | {Date}
Board: {NAME}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📊 CURRENT BOARD STATE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Open Assigned: {N} cards ({SP} SP)
In Progress: {N} cards ({SP} SP)
Done Now: {N} cards ({SP} SP)
Overdue: {N} cards

📈 CAPACITY ANALYSIS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Mapped Team Capacity: {X} SP/week
Current WIP Load: {X} SP
Concentration Risks: {list}

⚠️ RISK ASSESSMENT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
{Current risks with severity}

🎯 RECOMMENDATIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. {Recommendation}
2. {Recommendation}

📅 SNAPSHOT PREDICTIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Immediate bottlenecks: {list}
- Where to reduce WIP: {list}
- Who is overloaded right now: {list}`;

async function generateTrelloAnalyticsReport() {
  console.log('[TRELLO_ANALYTICS] Starting report generation...');
  const devs = getMappedTrelloDevelopers();
  const snapshot = await loadTrelloSnapshot();
  const { trelloConfig, cards } = snapshot;

  console.log('[TRELLO_ANALYTICS] Querying Brain...');
  const [patterns, strategic, alerts] = await Promise.all([
    brainQuery('What patterns have emerged in team workload and capacity?'),
    brainQuery('What strategic context should inform this board analysis?'),
    brainQuery('Any active risks or alerts I should include in analytics?')
  ]);

  const perDevData = buildTrelloPerDevBuckets(devs);
  assignTrelloCardsToDevelopers(perDevData, cards, trelloConfig);

  const doneCards = cards.filter(card => isTrelloDone(card, trelloConfig));
  const wipCards = cards.filter(card => isTrelloWip(card, trelloConfig) && !isTrelloDone(card, trelloConfig));
  const openCards = cards.filter(card => !isTrelloDone(card, trelloConfig));
  const overdueCards = cards.filter(card => isTrelloOverdue(card, trelloConfig));

  const contextData = {
    boardName: snapshot.boardName,
    today: new Date().toLocaleString('en-GB', { timeZone: 'Asia/Tashkent', dateStyle: 'full' }),
    developers: devs.map(d => ({
      name: d.name,
      trello_id: d.trello_id,
      trello_username: d.trello_username,
      capacity_sp_per_week: d.capacity_sp_per_week
    })),
    teamTotals: {
      totalCapacity: devs.reduce((sum, d) => sum + (d.capacity_sp_per_week || 0), 0),
      done: { cards: doneCards.length, sp: calculateTrelloTotalSP(doneCards) },
      inProgress: { cards: wipCards.length, sp: calculateTrelloTotalSP(wipCards) },
      openAssigned: { cards: openCards.length, sp: calculateTrelloTotalSP(openCards) },
      overdue: { cards: overdueCards.length, sp: calculateTrelloTotalSP(overdueCards) }
    },
    trelloData: perDevData,
    brainContext: { patterns, strategic, alerts }
  };

  const report = await generateWithLLM(TRELLO_ANALYTICS_PROMPT, contextData);
  const reportPath = path.join(reportsDir, 'latest-trello-analytics-report.txt');
  fs.writeFileSync(reportPath, report);
  console.log(`[TRELLO_ANALYTICS] Report saved to ${reportPath}`);

  return report;
}

// ============================================================================
// CLI
// ============================================================================

async function main() {
  const command = process.argv[2];

  try {
    let result;

    switch (command) {
      case 'daily':
        result = await generateDailyReport();
        break;
      case 'full':
        result = await generateFullReport();
        break;
      case 'analytics':
        result = await generateAnalyticsReport();
        break;
      case 'trello-daily':
        result = await generateTrelloDailyReport();
        break;
      case 'trello-full':
        result = await generateTrelloFullReport();
        break;
      case 'trello-analytics':
        result = await generateTrelloAnalyticsReport();
        break;
      default:
        result = {
          error: 'Unknown command',
          usage: [
            'report daily',
            'report full',
            'report analytics',
            'report trello-daily',
            'report trello-full',
            'report trello-analytics'
          ]
        };
        console.log(JSON.stringify(result, null, 2));
        return;
    }

    console.log('\n' + '='.repeat(60));
    console.log('REPORT OUTPUT:');
    console.log('='.repeat(60) + '\n');
    console.log(result);

  } catch (error) {
    console.error(JSON.stringify({ error: error.message }, null, 2));
    process.exit(1);
  }
}

// Export functions
module.exports = {
  generateDailyReport,
  generateFullReport,
  generateAnalyticsReport,
  generateTrelloDailyReport,
  generateTrelloFullReport,
  generateTrelloAnalyticsReport
};

// Run CLI if executed directly
if (require.main === module) {
  main();
}
