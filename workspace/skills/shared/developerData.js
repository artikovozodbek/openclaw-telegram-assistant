const fs = require('fs');
const path = require('path');

const jiraDevelopersPath = path.join(__dirname, '../../agents/default/data/developers.json');
const trelloDevelopersPath = path.join(__dirname, '../../agents/default/data/developers-trello.json');

function getActiveTracker(env = process.env) {
  const tracker = String(env.PM_TASK_TRACKER || env.TASK_MANAGER || 'jira').toLowerCase();
  return tracker === 'trello' ? 'trello' : 'jira';
}

function getDevelopersDataPath(env = process.env) {
  const tracker = getActiveTracker(env);
  if (tracker === 'trello' && fs.existsSync(trelloDevelopersPath)) {
    return trelloDevelopersPath;
  }
  return jiraDevelopersPath;
}

function loadDevelopers(env = process.env) {
  const data = fs.readFileSync(getDevelopersDataPath(env), 'utf8');
  const parsed = JSON.parse(data);
  return parsed.developers || [];
}

function getDeveloperIdentityValues(dev, tracker = getActiveTracker()) {
  const values = [dev.name, dev.telegram_id];

  if (tracker === 'trello') {
    values.push(dev.trello_id, dev.trello_username, dev.jira_id);
  } else {
    values.push(dev.jira_id, dev.trello_username, dev.trello_id);
  }

  return values.filter(value => value !== undefined && value !== null && value !== '');
}

function matchesDeveloperIdentifier(dev, identifier, tracker = getActiveTracker()) {
  const lowerIdentifier = String(identifier).toLowerCase();

  return getDeveloperIdentityValues(dev, tracker).some(value => {
    const stringValue = String(value).toLowerCase();
    return stringValue === lowerIdentifier || stringValue.includes(lowerIdentifier);
  });
}

function findDeveloperByIdentifier(identifier, developers, tracker = getActiveTracker()) {
  const lowerIdentifier = String(identifier).toLowerCase();

  let dev = developers.find(d => String(d.name || '').toLowerCase() === lowerIdentifier);
  if (dev) return dev;

  const exactFields = tracker === 'trello'
    ? ['trello_id', 'trello_username', 'jira_id']
    : ['jira_id', 'trello_username', 'trello_id'];

  for (const field of exactFields) {
    dev = developers.find(d => String(d[field] || '').toLowerCase() === lowerIdentifier);
    if (dev) return dev;
  }

  return developers.find(d => matchesDeveloperIdentifier(d, identifier, tracker)) || null;
}

function getPrimaryTrackerId(dev, tracker = getActiveTracker()) {
  if (tracker === 'trello') {
    return dev.trello_id || dev.trello_username || null;
  }
  return dev.jira_id || null;
}

module.exports = {
  getActiveTracker,
  getDevelopersDataPath,
  loadDevelopers,
  getDeveloperIdentityValues,
  matchesDeveloperIdentifier,
  findDeveloperByIdentifier,
  getPrimaryTrackerId
};
