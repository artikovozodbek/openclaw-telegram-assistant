#!/usr/bin/env node
import { pathToFileURL } from "node:url";

import { main } from "../workspace/lib/telegram-topic-onboarding.mjs";

export * from "../workspace/lib/telegram-topic-onboarding.mjs";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
      process.exit(1);
    }
  );
}
