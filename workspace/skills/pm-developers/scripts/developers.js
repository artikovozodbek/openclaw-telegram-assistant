#!/usr/bin/env node
/**
 * PM Developers Skill - CLI Script
 * Developer information, stats, and workload analysis
 *
 * Usage:
 *   dev info "<name or jira_id>"
 *   dev stats "<name>"
 *   dev list [--type dev|pm]
 *   dev workload "<name>"
 *   dev find-best --discipline "<backend|mobile|frontend>" --sp <points> --urgency "<critical|high|medium|low>"
 */

const fs = require('fs');
const path = require('path');
const { trelloWorkload } = require('../../pm-trello/scripts/trello');
const {
  getActiveTracker,
  loadDevelopers,
  findDeveloperByIdentifier,
  getPrimaryTrackerId
} = require('../../shared/developerData');

// Load environment variables for JIRA queries
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });

// JIRA configuration
const jiraConfig = {
  baseUrl: process.env.JIRA_URL,
  username: process.env.JIRA_USERNAME,
  password: process.env.JIRA_PASSWORD,
  projectKey: process.env.JIRA_PROJECT_KEY,
  storyPointsField: process.env.JIRA_STORY_POINTS_FIELD || 'customfield_10107'
};

const authHeader = 'Basic ' + Buffer.from(`${jiraConfig.username}:${jiraConfig.password}`).toString('base64');
const activeTracker = getActiveTracker();

/**
 * Load all developers
 */
function getAllDevelopers() {
  return loadDevelopers();
}

/**
 * Get developer by JIRA ID
 */
function getDeveloperByJiraId(jiraId) {
  const developers = getAllDevelopers();
  return developers.find(d => String(d.jira_id || '').toLowerCase() === jiraId.toLowerCase()) || null;
}

/**
 * Get developer by name (fuzzy match)
 */
function getDeveloperByName(name) {
  const developers = getAllDevelopers();
  return findDeveloperByIdentifier(name, developers, activeTracker);
}

/**
 * Get developers by position/discipline
 */
function getDevelopersByPosition(position) {
  const developers = getAllDevelopers();
  const lowerPos = position.toLowerCase();
  return developers.filter(d =>
    d.position.toLowerCase().includes(lowerPos) ||
    d.main_tech.toLowerCase().includes(lowerPos)
  );
}

/**
 * Get all devs (not PMs)
 */
function getDevsOnly() {
  const developers = getAllDevelopers();
  return developers.filter(d => d.type === 'dev');
}

/**
 * Get project managers
 */
function getPMs() {
  const developers = getAllDevelopers();
  return developers.filter(d => d.type === 'pm');
}

/**
 * Get developer summary for AI prompt
 */
function getDevelopersSummary() {
  const developers = getAllDevelopers();
  return developers.map(d => ({
    id: d.id,
    name: d.name,
    jira_id: d.jira_id,
    trello_id: d.trello_id || null,
    trello_username: d.trello_username || null,
    tracker_id: getPrimaryTrackerId(d, activeTracker),
    tracker: activeTracker,
    telegram_id: d.telegram_id,
    type: d.type,
    position: d.position,
    level: d.level,
    language: d.language,
    main_tech: d.main_tech,
    max_parallel_tasks: d.max_parallel_tasks,
    urgent_ok: d.urgent_ok,
    preferred_tasks: d.preferred_tasks,
    avoid_tasks: d.avoid_tasks,
    weaknesses: d.weaknesses,
    handles_time_pressure: d.handles_time_pressure,
    learns_fast: d.learns_fast,
    responsibility: d.responsibility,
    capacity_sp_per_week: d.capacity_sp_per_week
  }));
}

async function getTrelloWorkload(dev) {
  if (!dev.trello_id && !dev.trello_username) {
    return {
      issues: [],
      issueCount: 0,
      totalSP: 0,
      wipCount: 0,
      unmapped: true
    };
  }

  const workload = await trelloWorkload();
  const keys = [dev.trello_username, dev.trello_id].filter(Boolean);

  for (const key of keys) {
    if (workload[key]) {
      return workload[key];
    }
  }

  return {
    issues: [],
    issueCount: 0,
    totalSP: 0,
    wipCount: 0
  };
}

async function getTrackerWorkload(dev) {
  if (activeTracker === 'trello') {
    return getTrelloWorkload(dev);
  }
  return getJiraWorkload(dev.jira_id);
}

/**
 * Query JIRA for developer workload
 */
async function getJiraWorkload(jiraId) {
  if (!jiraConfig.baseUrl) {
    return { error: 'JIRA not configured' };
  }

  const jql = `project = ${jiraConfig.projectKey} AND assignee = "${jiraId}" AND statusCategory != Done`;

  const response = await fetch(`${jiraConfig.baseUrl}/rest/api/2/search`, {
    method: 'POST',
    headers: {
      'Authorization': authHeader,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      jql,
      fields: ['key', 'summary', 'status', 'duedate', jiraConfig.storyPointsField],
      maxResults: 100
    })
  });

  if (!response.ok) {
    throw new Error(`JIRA query failed: ${response.status}`);
  }

  const data = await response.json();
  const issues = data.issues.map(issue => ({
    key: issue.key,
    summary: issue.fields.summary,
    status: issue.fields.status?.name,
    duedate: issue.fields.duedate,
    sp: issue.fields[jiraConfig.storyPointsField] || 3
  }));

  const totalSP = issues.reduce((sum, i) => sum + i.sp, 0);
  const wipCount = issues.filter(i => i.status === 'In Progress').length;

  return {
    issues,
    issueCount: issues.length,
    totalSP,
    wipCount
  };
}

/**
 * Get developer info with optional JIRA stats
 */
async function getDevInfo(nameOrId, includeJira = true) {
  const dev = getDeveloperByName(nameOrId);
  if (!dev) {
    return { error: `Developer not found: ${nameOrId}` };
  }

  const result = { ...dev };

  if (activeTracker === 'trello' || (includeJira && jiraConfig.baseUrl)) {
    try {
      const workload = await getTrackerWorkload(dev);
      if (activeTracker === 'trello') {
        result.trello_workload = workload;
      } else {
        result.jira_workload = workload;
      }
      result.utilization = workload.totalSP / dev.capacity_sp_per_week * 100;
    } catch (e) {
      result[`${activeTracker}_error`] = e.message;
    }
  }

  return result;
}

/**
 * Get developer stats
 */
async function getDevStats(nameOrId) {
  const dev = getDeveloperByName(nameOrId);
  if (!dev) {
    return { error: `Developer not found: ${nameOrId}` };
  }

  const result = {
    name: dev.name,
    jira_id: dev.jira_id,
    position: dev.position,
    level: dev.level,
    capacity_sp_per_week: dev.capacity_sp_per_week,
    max_parallel_tasks: dev.max_parallel_tasks
  };

  if (activeTracker === 'trello' || jiraConfig.baseUrl) {
    try {
      const workload = await getTrackerWorkload(dev);
      result.open_issues = workload.issueCount;
      result.total_sp = workload.totalSP;
      result.wip_count = workload.wipCount;
      result.utilization_percent = Math.round(workload.totalSP / dev.capacity_sp_per_week * 100);
      result.available_sp = Math.max(0, dev.capacity_sp_per_week - workload.totalSP);
      result.can_take_more = workload.issueCount < dev.max_parallel_tasks;
      if (workload.unmapped) {
        result.unmapped = true;
      }
    } catch (e) {
      result[`${activeTracker}_error`] = e.message;
    }
  }

  return result;
}

/**
 * Find best developer for a task
 */
async function findBestDeveloper(discipline, sp, urgency = 'medium') {
  const allDevs = getDevsOnly();

  // Filter by discipline
  const matchingDevs = allDevs.filter(d => {
    const pos = d.position.toLowerCase();
    const tech = d.main_tech.toLowerCase();
    const disc = discipline.toLowerCase();

    if (disc === 'backend') {
      return pos.includes('backend') || tech.includes('laravel') || tech.includes('php');
    }
    if (disc === 'mobile' || disc === 'flutter') {
      return pos.includes('flutter') || tech.includes('flutter');
    }
    if (disc === 'frontend') {
      return pos.includes('frontend') || tech.includes('js') || tech.includes('react');
    }
    if (activeTracker === 'trello' && !d.trello_id && !d.trello_username) {
      return false;
    }
    return true;
  });

  if (matchingDevs.length === 0) {
    return { error: `No developers found for discipline: ${discipline}` };
  }

  // Score each developer
  const scored = [];
  for (const dev of matchingDevs) {
    let score = 0;
    const reasons = [];

    // Level bonus
    score += dev.level;
    reasons.push(`Level ${dev.level}`);

    // Urgency handling
    if (urgency === 'critical' || urgency === 'high') {
      if (dev.urgent_ok) {
        score += 2;
        reasons.push('Can handle urgency');
      } else {
        score -= 3;
        reasons.push('Not good with urgency');
      }
    }

    // Get JIRA workload
    if (activeTracker === 'trello' || jiraConfig.baseUrl) {
      try {
        const workload = await getTrackerWorkload(dev);
        const utilization = workload.totalSP / dev.capacity_sp_per_week;

        // Capacity score
        if (utilization < 0.5) {
          score += 3;
          reasons.push(`Low workload (${Math.round(utilization * 100)}%)`);
        } else if (utilization < 0.75) {
          score += 1;
          reasons.push(`Medium workload (${Math.round(utilization * 100)}%)`);
        } else {
          score -= 2;
          reasons.push(`High workload (${Math.round(utilization * 100)}%)`);
        }

        // WIP count
        if (workload.wipCount >= dev.max_parallel_tasks) {
          score -= 5;
          reasons.push('At max parallel tasks');
        }

        // Can fit SP?
        if (workload.totalSP + sp > dev.capacity_sp_per_week) {
          score -= 3;
          reasons.push('Would exceed capacity');
        }
      } catch (e) {
        // Continue without JIRA data
      }
    }

    scored.push({
      name: dev.name,
      jira_id: dev.jira_id,
      trello_id: dev.trello_id || null,
      trello_username: dev.trello_username || null,
      position: dev.position,
      level: dev.level,
      score,
      reasons
    });
  }

  // Sort by score
  scored.sort((a, b) => b.score - a.score);

  return {
    discipline,
    sp,
    urgency,
    candidates: scored.slice(0, 5)
  };
}

/**
 * Parse command line arguments
 */
function parseArgs(args) {
  const result = { _: [] };
  let i = 0;

  while (i < args.length) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const nextArg = args[i + 1];
      if (nextArg && !nextArg.startsWith('--')) {
        result[key] = nextArg;
        i += 2;
      } else {
        result[key] = true;
        i++;
      }
    } else {
      result._.push(arg);
      i++;
    }
  }

  return result;
}

/**
 * Main CLI handler
 */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];

  try {
    let result;

    switch (command) {
      case 'info':
        const infoName = args._[1];
        if (!infoName) {
          throw new Error('Name required. Usage: dev info "<name>"');
        }
        result = await getDevInfo(infoName);
        break;

      case 'stats':
        const statsName = args._[1];
        if (!statsName) {
          throw new Error('Name required. Usage: dev stats "<name>"');
        }
        result = await getDevStats(statsName);
        break;

      case 'list':
        if (args.type === 'dev') {
          result = getDevsOnly().map(d => ({
            name: d.name,
            jira_id: d.jira_id,
            trello_id: d.trello_id || null,
            trello_username: d.trello_username || null,
            position: d.position,
            level: d.level
          }));
        } else if (args.type === 'pm') {
          result = getPMs().map(d => ({
            name: d.name,
            jira_id: d.jira_id,
            trello_id: d.trello_id || null,
            trello_username: d.trello_username || null,
            position: d.position
          }));
        } else {
          result = getDevelopersSummary();
        }
        break;

      case 'workload':
        const wlName = args._[1];
        if (!wlName) {
          throw new Error('Name required. Usage: dev workload "<name>"');
        }
        const dev = getDeveloperByName(wlName);
        if (!dev) {
          throw new Error(`Developer not found: ${wlName}`);
        }
        result = await getTrackerWorkload(dev);
        result.developer = dev.name;
        result.capacity = dev.capacity_sp_per_week;
        break;

      case 'find-best':
        if (!args.discipline) {
          throw new Error('Discipline required. Usage: dev find-best --discipline "backend" --sp 5');
        }
        result = await findBestDeveloper(
          args.discipline,
          parseInt(args.sp) || 3,
          args.urgency || 'medium'
        );
        break;

      default:
        result = {
          error: 'Unknown command',
          usage: [
            'dev info "<name or jira_id>"',
            'dev stats "<name>"',
            'dev list [--type dev|pm]',
            'dev workload "<name>"',
            'dev find-best --discipline "<backend|mobile|frontend>" --sp <points> --urgency "<level>"'
          ]
        };
    }

    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ error: error.message }, null, 2));
    process.exit(1);
  }
}

// Export functions for use as module
module.exports = {
  getAllDevelopers,
  getDeveloperByJiraId,
  getDeveloperByName,
  getDevelopersByPosition,
  getDevsOnly,
  getPMs,
  getDevelopersSummary,
  getDevInfo,
  getDevStats,
  getTrelloWorkload,
  getTrackerWorkload,
  getJiraWorkload,
  findBestDeveloper
};

// Run CLI if executed directly
if (require.main === module) {
  main();
}
