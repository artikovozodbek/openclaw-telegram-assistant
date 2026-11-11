#!/usr/bin/env node
import { pathToFileURL } from "node:url";

import { main } from "../lib/telegram-topic-onboarding.mjs";

const CONTAINER_DEFAULTS = {
  configPath: process.env.OPENCLAW_CONFIG_PATH || "/home/node/.openclaw/openclaw.json",
  registryRoot: "/home/node/.openclaw/workspace/memory/topic-intelligence/groups",
  workspacesRoot: "/home/node/.openclaw/workspaces",
  tgWatcherUrl: `http://127.0.0.1:${process.env.SEND_PORT || 18792}`,
  disableDockerFallback: true,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), CONTAINER_DEFAULTS).then(
    (code) => process.exit(code),
    (error) => {
      console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
      process.exit(1);
    }
  );
}
