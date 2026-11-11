#!/usr/bin/env node
/**
 * PM JIRA Skill - CLI Script
 * JIRA Server integration for PM workflows
 *
 * Usage:
 *   jira search "<JQL>"
 *   jira create --summary "..." --assignee "..." --sp 3 --due "YYYY-MM-DD"
 *   jira project-info
 *   jira users
 *   jira workload
 *   jira attach <ISSUE_KEY> <FILE_PATH>
 */

const fs = require('fs');
const path = require('path');

// Load environment variables
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });

// Configuration from environment
const config = {
  baseUrl: process.env.JIRA_URL,
  username: process.env.JIRA_USERNAME,
  password: process.env.JIRA_PASSWORD,
  projectKey: process.env.JIRA_PROJECT_KEY,
  projectId: process.env.JIRA_PROJECT_ID,
  issueTypeId: process.env.JIRA_ISSUE_TYPE_ID || '10002',
  storyPointsField: process.env.JIRA_STORY_POINTS_FIELD || 'customfield_10107'
};

// Base64 auth header
const authHeader = 'Basic ' + Buffer.from(`${config.username}:${config.password}`).toString('base64');

/**
 * Search JIRA issues using JQL with automatic pagination
 */
async function jiraSearch(jql) {
  const allIssues = [];
  let startAt = 0;
  const batchSize = 100;
  let total = 0;
  const fields = ['key', 'summary', 'assignee', 'status', 'duedate', 'created', config.storyPointsField];

  do {
    const response = await fetch(`${config.baseUrl}/rest/api/2/search`, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        jql,
        fields,
        startAt,
        maxResults: batchSize
      })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`JIRA search failed: ${response.status} - ${error}`);
    }

    const data = await response.json();
    total = data.total;

    const issues = data.issues.map(issue => ({
      key: issue.key,
      summary: issue.fields.summary,
      assignee: issue.fields.assignee?.name || null,
      assigneeDisplayName: issue.fields.assignee?.displayName || null,
      status: issue.fields.status?.name || null,
      duedate: issue.fields.duedate,
      created: issue.fields.created,
      storyPoints: issue.fields[config.storyPointsField]
    }));

    allIssues.push(...issues);
    startAt += batchSize;
  } while (startAt < total);

  return { total: allIssues.length, issues: allIssues };
}

/**
 * Validate and fix date string (YYYY-MM-DD)
 */
function validateDate(dateStr) {
  if (!dateStr) return null;

  const [year, month, day] = dateStr.split('-').map(Number);
  if (!year || !month || !day) return dateStr;

  const date = new Date(year, month - 1, day);

  if (date.getMonth() !== month - 1 || date.getDate() !== day) {
    const lastDay = new Date(year, month, 0).getDate();
    const fixedDay = Math.min(day, lastDay);
    return `${year}-${String(month).padStart(2, '0')}-${String(fixedDay).padStart(2, '0')}`;
  }

  return dateStr;
}

/**
 * Resolve a project identifier (key OR numeric id) to both.
 * Returns { id, key, name } or throws.
 */
async function jiraResolveProject(keyOrId) {
  if (!keyOrId) return { id: config.projectId, key: config.projectKey };
  const response = await fetch(`${config.baseUrl}/rest/api/2/project/${encodeURIComponent(keyOrId)}`, {
    headers: { 'Authorization': authHeader }
  });
  if (!response.ok) {
    throw new Error(`JIRA resolve project "${keyOrId}" failed: ${response.status}`);
  }
  const data = await response.json();
  return { id: data.id, key: data.key, name: data.name };
}

/**
 * List all projects visible to the authenticated user.
 * Returns [{ id, key, name, lead }, ...]
 */
async function jiraListProjects() {
  const response = await fetch(`${config.baseUrl}/rest/api/2/project`, {
    headers: { 'Authorization': authHeader }
  });
  if (!response.ok) {
    throw new Error(`JIRA list projects failed: ${response.status}`);
  }
  const data = await response.json();
  return data.map((p) => ({
    id: p.id,
    key: p.key,
    name: p.name,
    lead: p.lead?.name || null,
  }));
}

/**
 * Create a JIRA issue.
 * `project` is optional (key or numeric id); defaults to env JIRA_PROJECT_KEY/ID.
 */
async function jiraCreate({ summary, description, assignee, storyPoints, dueDate, project }) {
  const validDueDate = validateDate(dueDate);
  const resolvedProject = await jiraResolveProject(project);

  const body = {
    fields: {
      project: { id: resolvedProject.id },
      issuetype: { id: config.issueTypeId },
      summary,
      description: description || '',
      assignee: assignee ? { name: assignee.trim() } : null,
      duedate: validDueDate,
      [config.storyPointsField]: storyPoints || null
    }
  };

  const response = await fetch(`${config.baseUrl}/rest/api/2/issue`, {
    method: 'POST',
    headers: {
      'Authorization': authHeader,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`JIRA create issue failed: ${response.status} - ${error}`);
  }

  const data = await response.json();
  return {
    key: data.key,
    id: data.id,
    url: `${config.baseUrl}/browse/${data.key}`
  };
}

/**
 * Get project information
 */
async function jiraProjectInfo() {
  const response = await fetch(`${config.baseUrl}/rest/api/2/project/${config.projectKey}`, {
    headers: { 'Authorization': authHeader }
  });

  if (!response.ok) {
    throw new Error(`JIRA project info failed: ${response.status}`);
  }

  const data = await response.json();
  return {
    key: data.key,
    name: data.name,
    lead: data.lead?.name || null,
    leadDisplayName: data.lead?.displayName || null
  };
}

/**
 * Get assignable users
 */
async function jiraGetUsers() {
  const response = await fetch(
    `${config.baseUrl}/rest/api/2/user/assignable/multiProjectSearch?projectKeys=${config.projectKey}`,
    { headers: { 'Authorization': authHeader } }
  );

  if (!response.ok) {
    throw new Error(`JIRA get users failed: ${response.status}`);
  }

  const data = await response.json();
  return data.map(user => ({
    name: user.name,
    displayName: user.displayName,
    emailAddress: user.emailAddress
  }));
}

/**
 * Get workload for all developers
 */
async function jiraWorkload() {
  const jql = `project = ${config.projectKey} AND assignee is not EMPTY AND statusCategory != Done`;
  const result = await jiraSearch(jql);

  const workload = {};
  for (const issue of result.issues) {
    const assignee = issue.assignee;
    if (assignee) {
      if (!workload[assignee]) {
        workload[assignee] = { issues: [], totalSP: 0, wipCount: 0, issueCount: 0 };
      }
      workload[assignee].issues.push({
        key: issue.key,
        summary: issue.summary,
        status: issue.status,
        duedate: issue.duedate,
        sp: issue.storyPoints || 3
      });
      workload[assignee].totalSP += issue.storyPoints || 3;
      workload[assignee].issueCount++;
      if (issue.status === 'In Progress') {
        workload[assignee].wipCount++;
      }
    }
  }

  return workload;
}

/**
 * Attach file to issue
 */
async function jiraAttach(issueKey, filePath) {
  const FormData = require('form-data');
  const http = require('http');
  const https = require('https');
  const { URL } = require('url');

  return new Promise((resolve, reject) => {
    const filename = path.basename(filePath);
    const form = new FormData();
    form.append('file', fs.createReadStream(filePath), filename);

    const url = new URL(`${config.baseUrl}/rest/api/2/issue/${issueKey}/attachments`);
    const isHttps = url.protocol === 'https:';
    const httpModule = isHttps ? https : http;

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        ...form.getHeaders(),
        'Authorization': authHeader,
        'X-Atlassian-Token': 'no-check'
      }
    };

    const req = httpModule.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            resolve({ success: true, message: 'File attached' });
          }
        } else {
          reject(new Error(`JIRA attachment failed: ${res.statusCode} - ${data}`));
        }
      });
    });

    req.on('error', reject);
    form.pipe(req);
  });
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
      case 'search':
        const jql = args._[1] || args.jql;
        if (!jql) {
          throw new Error('JQL query required. Usage: jira search "<JQL>"');
        }
        result = await jiraSearch(jql);
        break;

      case 'create':
        if (!args.summary) {
          throw new Error('Summary required. Usage: jira create --summary "..." --assignee "..." [--project KEY]');
        }
        result = await jiraCreate({
          summary: args.summary,
          description: args.description || args.desc,
          assignee: args.assignee,
          storyPoints: args.sp ? parseInt(args.sp) : 3,
          dueDate: args.due,
          project: args.project,
        });
        break;

      case 'project-info':
        result = await jiraProjectInfo();
        break;

      case 'projects':
        result = await jiraListProjects();
        break;

      case 'users':
        result = await jiraGetUsers();
        break;

      case 'workload':
        result = await jiraWorkload();
        break;

      case 'attach':
        const issueKey = args._[1];
        const filePath = args._[2];
        if (!issueKey || !filePath) {
          throw new Error('Usage: jira attach <ISSUE_KEY> <FILE_PATH>');
        }
        result = await jiraAttach(issueKey, filePath);
        break;

      default:
        result = {
          error: 'Unknown command',
          usage: [
            'jira search "<JQL>"',
            'jira create --summary "..." --assignee "..." --sp 3 --due "YYYY-MM-DD" [--project KEY]',
            'jira project-info',
            'jira projects                    # list all projects (id, key, name)',
            'jira users',
            'jira workload',
            'jira attach <ISSUE_KEY> <FILE_PATH>'
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
  jiraSearch,
  jiraCreate,
  jiraProjectInfo,
  jiraListProjects,
  jiraResolveProject,
  jiraGetUsers,
  jiraWorkload,
  jiraAttach
};

// Run CLI if executed directly
if (require.main === module) {
  main();
}
