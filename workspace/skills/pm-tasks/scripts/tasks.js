#!/usr/bin/env node
/**
 * PM Tasks Skill - CLI Script
 * Task queue for collecting PM tasks before batch JIRA creation
 *
 * Usage:
 *   tasks add "<description>" [--type text|voice|photo] [--chat <id>]
 *   tasks list [--chat <id>]
 *   tasks count [--chat <id>]
 *   tasks clear [--chat <id>]
 *   tasks brain-mode enable|check|disable [--chat <id>]
 *   tasks collection-mode enable|check|disable [--chat <id>]
 */

const fs = require('fs');
const path = require('path');

// Data file path
const dataPath = path.join(__dirname, '../../../agents/default/data/task_queue.json');

/**
 * Load current queue state
 */
function loadQueue() {
  try {
    const data = fs.readFileSync(dataPath, 'utf8');
    const queue = JSON.parse(data);
    if (!queue.collection_mode) {
      queue.collection_mode = {};
    }
    if (!queue.brain_mode) {
      queue.brain_mode = {};
    }
    if (!queue.tasks) {
      queue.tasks = [];
    }
    return queue;
  } catch (e) {
    return { tasks: [], brain_mode: {}, collection_mode: {} };
  }
}

/**
 * Save queue state
 */
function saveQueue(queue) {
  const dir = path.dirname(dataPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(dataPath, JSON.stringify(queue, null, 2));
}

/**
 * Add a task to the queue
 */
function taskAdd(chatId, text, type = 'text') {
  const queue = loadQueue();
  queue.tasks.push({
    chatId: String(chatId),
    text,
    type,
    timestamp: new Date().toISOString()
  });
  saveQueue(queue);
  return { success: true, count: queue.tasks.length };
}

/**
 * Get all tasks for a chat
 */
function taskList(chatId = null) {
  const queue = loadQueue();
  if (chatId) {
    return queue.tasks.filter(t => t.chatId === String(chatId));
  }
  return queue.tasks;
}

/**
 * Clear all tasks for a chat
 */
function taskClear(chatId = null) {
  const queue = loadQueue();
  if (chatId) {
    queue.tasks = queue.tasks.filter(t => t.chatId !== String(chatId));
  } else {
    queue.tasks = [];
  }
  saveQueue(queue);
  return { success: true, remaining: queue.tasks.length };
}

/**
 * Get task count
 */
function taskCount(chatId = null) {
  const tasks = taskList(chatId);
  return { count: tasks.length };
}

/**
 * Enable brain mode for a chat
 */
function brainModeEnable(chatId) {
  const queue = loadQueue();
  queue.brain_mode[String(chatId)] = true;
  saveQueue(queue);
  return { success: true, brain_mode: true };
}

/**
 * Check if brain mode is active
 */
function brainModeCheck(chatId) {
  const queue = loadQueue();
  return { brain_mode: queue.brain_mode[String(chatId)] === true };
}

/**
 * Disable brain mode for a chat
 */
function brainModeDisable(chatId) {
  const queue = loadQueue();
  delete queue.brain_mode[String(chatId)];
  saveQueue(queue);
  return { success: true, brain_mode: false };
}

/**
 * Enable collection mode for a chat
 */
function collectionModeEnable(chatId) {
  const queue = loadQueue();
  queue.collection_mode[String(chatId)] = true;
  saveQueue(queue);
  return { success: true, collection_mode: true };
}

/**
 * Check if collection mode is active
 */
function collectionModeCheck(chatId) {
  const queue = loadQueue();
  return { collection_mode: queue.collection_mode[String(chatId)] === true };
}

/**
 * Disable collection mode for a chat
 */
function collectionModeDisable(chatId) {
  const queue = loadQueue();
  delete queue.collection_mode[String(chatId)];
  saveQueue(queue);
  return { success: true, collection_mode: false };
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
  const subCommand = args._[1];
  const chatId = args.chat || 'default';

  try {
    let result;

    switch (command) {
      case 'add':
        const text = args._[1];
        if (!text) {
          throw new Error('Text required. Usage: tasks add "<description>" [--chat <id>]');
        }
        result = taskAdd(chatId, text, args.type || 'text');
        break;

      case 'list':
        result = { tasks: taskList(args.chat || null) };
        break;

      case 'count':
        result = taskCount(args.chat || null);
        break;

      case 'clear':
        result = taskClear(args.chat || null);
        break;

      case 'brain-mode':
        if (!subCommand) {
          throw new Error('Subcommand required: enable, check, disable');
        }
        switch (subCommand) {
          case 'enable':
            result = brainModeEnable(chatId);
            break;
          case 'check':
            result = brainModeCheck(chatId);
            break;
          case 'disable':
            result = brainModeDisable(chatId);
            break;
          default:
            throw new Error('Unknown subcommand. Use: enable, check, disable');
        }
        break;

      case 'collection-mode':
        if (!subCommand) {
          throw new Error('Subcommand required: enable, check, disable');
        }
        switch (subCommand) {
          case 'enable':
            result = collectionModeEnable(chatId);
            break;
          case 'check':
            result = collectionModeCheck(chatId);
            break;
          case 'disable':
            result = collectionModeDisable(chatId);
            break;
          default:
            throw new Error('Unknown subcommand. Use: enable, check, disable');
        }
        break;

      default:
        result = {
          error: 'Unknown command',
          usage: [
            'tasks add "<description>" [--type text|voice|photo] [--chat <id>]',
            'tasks list [--chat <id>]',
            'tasks count [--chat <id>]',
            'tasks clear [--chat <id>]',
            'tasks brain-mode enable|check|disable [--chat <id>]',
            'tasks collection-mode enable|check|disable [--chat <id>]'
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
  taskAdd,
  taskList,
  taskClear,
  taskCount,
  brainModeEnable,
  brainModeCheck,
  brainModeDisable,
  collectionModeEnable,
  collectionModeCheck,
  collectionModeDisable
};

// Run CLI if executed directly
if (require.main === module) {
  main();
}
