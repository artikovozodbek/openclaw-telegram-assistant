#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { spawnSync } = require("child_process");

const workspaceRoot = path.resolve(__dirname, "..");
const projectRoot = path.resolve(workspaceRoot, "..");
const defaultConfigDir = path.join(workspaceRoot, ".config", "gws");
const accountsRoot = path.join(workspaceRoot, ".config", "gws-accounts");
const defaultClientSecret = path.join(defaultConfigDir, "client_secret.json");
const defaultEnvFile = path.join(projectRoot, ".env");
const accountEnvKeys = [
  "GOOGLE_WORKSPACE_ACCOUNT_EMAIL",
  "OPENCLAW_GWS_ACCOUNT_EMAIL",
  "GWS_ACCOUNT_EMAIL",
  "GMAIL_ACCOUNT",
];

function usage() {
  return [
    "Usage:",
    "  gws-register-account [--profile <name-or-email>] [--client-secret <path>] [--force] [--yes]",
    "  gws-register-account --from-env [--skip-if-missing] [--set-default] [--yes]",
    "",
    "Registers a Google account into a separate gws profile under:",
    `  ${accountsRoot}`,
    "",
    "The OAuth flow requests full gws access via:",
    "  gws auth login --full",
    "",
    "Options:",
    "  --profile        Profile directory name or account email. Prompted if omitted.",
    "  --from-env       Read the account email/profile from the root .env file.",
    `                  Supported keys: ${accountEnvKeys.join(", ")}.`,
    "  --project-env    .env path to read/update. Defaults to the project root .env.",
    "  --skip-if-missing",
    "                  Exit successfully when --from-env finds no account value.",
    "  --set-default    Update .env so OpenClaw uses this gws profile by default.",
    "  --startup        Quieter, idempotent output for START.bat/start.sh.",
    "  --client-secret  OAuth client JSON to seed the profile. Defaults to the main profile client_secret.json.",
    "  --force          Allow re-authenticating an existing profile.",
    "  --yes            Skip the local confirmation prompt.",
    "  --help           Show this help.",
  ].join("\n");
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      out._ = out._ || [];
      out._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function prompt(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function parseEnvValue(rawValue) {
  let value = String(rawValue || "").trim();
  if (!value) {
    return "";
  }

  const quote = value[0];
  if ((quote === "\"" || quote === "'") && value.endsWith(quote)) {
    value = value.slice(1, -1);
    if (quote === "\"") {
      value = value
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, "\"")
        .replace(/\\\\/g, "\\");
    }
    return value.trim();
  }

  return value.replace(/\s+#.*$/, "").trim();
}

function readEnvFile(envFile) {
  if (!fs.existsSync(envFile)) {
    return {};
  }

  const values = {};
  const content = fs.readFileSync(envFile, "utf8").replace(/^\ufeff/, "");
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) {
      continue;
    }
    values[match[1]] = parseEnvValue(match[2]);
  }
  return values;
}

function findAccountFromEnv(envFile) {
  const fileValues = readEnvFile(envFile);
  for (const key of accountEnvKeys) {
    if (fileValues[key]) {
      return { key, value: fileValues[key] };
    }
  }
  for (const key of accountEnvKeys) {
    const value = String(process.env[key] || "").trim();
    if (value) {
      return { key, value };
    }
  }
  return null;
}

function formatEnvValue(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(text)) {
    return text;
  }
  return JSON.stringify(text);
}

function writeEnvValues(envFile, values) {
  const dir = path.dirname(envFile);
  fs.mkdirSync(dir, { recursive: true });

  const content = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8") : "";
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.length ? content.split(/\r\n|\n|\r/) : [];
  if (lines.length && lines[lines.length - 1] === "") {
    lines.pop();
  }

  const keys = Object.keys(values);
  const seen = new Set();
  const nextLines = lines.map((line) => {
    const match = line.match(/^(\s*)(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)(\s*)=(.*)$/);
    if (match && Object.prototype.hasOwnProperty.call(values, match[2])) {
      seen.add(match[2]);
      return `${match[1]}${match[2]}=${formatEnvValue(values[match[2]])}`;
    }
    return line;
  });

  const missing = keys.filter((key) => !seen.has(key));
  if (missing.length) {
    if (nextLines.length && nextLines[nextLines.length - 1].trim() !== "") {
      nextLines.push("");
    }
    nextLines.push("# Google Workspace CLI default profile");
    for (const key of missing) {
      nextLines.push(`${key}=${formatEnvValue(values[key])}`);
    }
  }

  fs.writeFileSync(envFile, `${nextLines.join(eol)}${eol}`);
}

function profileSlug(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/@/g, "-at-")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || `account-${new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14)}`;
}

function ensureInside(child, parent) {
  const childResolved = path.resolve(child);
  const parentResolved = path.resolve(parent);
  const relative = path.relative(parentResolved, childResolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to use profile path outside accounts directory: ${childResolved}`);
  }
  return childResolved;
}

function copyClientSecret(src, dest) {
  if (!fs.existsSync(src)) {
    throw new Error(
      [
        `OAuth client JSON not found: ${src}`,
        "",
        "Run this again with --client-secret <path-to-client_secret.json>, or place",
        "client_secret.json in the default gws profile first.",
      ].join("\n"),
    );
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  try {
    fs.chmodSync(dest, 0o600);
  } catch {
    // Windows-mounted filesystems may ignore Unix mode changes.
  }
}

function runGws(args, env) {
  const gws = process.platform === "win32"
    ? path.join(workspaceRoot, "bin", "gws.cmd")
    : path.join(workspaceRoot, "bin", "gws");

  if (!fs.existsSync(gws)) {
    throw new Error(`gws launcher not found: ${gws}`);
  }

  const result = spawnSync(gws, args, {
    cwd: workspaceRoot,
    env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  if (result.error) {
    throw result.error;
  }
  return result.status ?? 1;
}

function containerProfilePath(slug) {
  return `/home/node/.openclaw/workspace/.config/gws-accounts/${slug}`;
}

function setDefaultProfile(envFile, slug, quiet) {
  writeEnvValues(envFile, {
    GOOGLE_WORKSPACE_CLI_CONFIG_DIR: containerProfilePath(slug),
    GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND: "file",
  });

  if (!quiet) {
    console.log(`Updated ${envFile} to use this profile by default.`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    console.log(usage());
    return;
  }

  const envFile = path.resolve(args["project-env"] || args["env-path"] || defaultEnvFile);
  const startupMode = Boolean(args.startup || args["skip-if-missing"]);
  const quiet = Boolean(args.startup);
  let profile = args.profile || args.p;
  if (!profile && args["from-env"]) {
    const configured = findAccountFromEnv(envFile);
    if (configured) {
      profile = configured.value;
    } else if (args["skip-if-missing"]) {
      if (!quiet) {
        console.log("No Google Workspace account configured in .env; skipping.");
      }
      return;
    }
  }

  if (!profile) {
    profile = await prompt("Google account email or profile name: ");
  }
  const slug = profileSlug(profile);
  const profileDir = ensureInside(path.join(accountsRoot, slug), accountsRoot);
  const clientSecretSource = path.resolve(args["client-secret"] || defaultClientSecret);
  const profileClientSecret = path.join(profileDir, "client_secret.json");
  const credentialsFile = path.join(profileDir, "credentials.enc");

  if (quiet) {
    console.log("[gws] Google Workspace account is configured; checking local profile.");
  } else {
    console.log("");
    console.log(`Profile: ${slug}`);
    console.log(`Config directory: ${profileDir}`);
    console.log("");
    console.log("This will open Google's OAuth flow and request full gws access:");
    console.log("Drive, Sheets, Gmail modify, Calendar, Docs, Slides, Tasks, Pub/Sub, Cloud Platform, and identity scopes.");
    console.log("Google may still block restricted scopes unless the OAuth app is verified or the Workspace admin allows them.");
    console.log("");
  }

  if (fs.existsSync(credentialsFile) && !args.force) {
    if (startupMode || args["set-default"]) {
      if (args["set-default"]) {
        setDefaultProfile(envFile, slug, quiet);
      }
      console.log(quiet ? "[gws] Google Workspace profile already registered." : "This profile already has encrypted credentials.");
      return;
    }

    throw new Error([
      "This profile already has encrypted credentials.",
      "Run again with --force to re-authenticate it, or choose a different --profile.",
    ].join("\n"));
  }

  if (!args.yes && !args.y) {
    const answer = await prompt("Continue with full access OAuth login? [y/N] ");
    if (!/^y(es)?$/i.test(answer)) {
      console.log("Cancelled.");
      return;
    }
  }

  copyClientSecret(clientSecretSource, profileClientSecret);

  const env = {
    ...process.env,
    GOOGLE_WORKSPACE_CLI_CONFIG_DIR: profileDir,
    GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND: "file",
    OPENCLAW_GWS_DISABLE_RUNTIME_CONFIG: "1",
  };

  console.log("");
  console.log("Starting OAuth login...");
  const loginStatus = runGws(["auth", "login", "--full"], env);
  if (loginStatus !== 0) {
    process.exit(loginStatus);
  }

  if (args["set-default"]) {
    setDefaultProfile(envFile, slug, quiet);
  }

  if (!quiet) {
    console.log("");
    console.log("OAuth status for this profile:");
    const status = runGws(["auth", "status"], env);
    if (status !== 0) {
      process.exit(status);
    }
  }

  const containerPath = containerProfilePath(slug);
  console.log("");
  if (quiet) {
    console.log("[gws] Google Workspace profile registered.");
  } else {
    console.log("Registered profile:");
    console.log(`  Host path: ${profileDir}`);
    console.log(`  Container path: ${containerPath}`);
    console.log("");
    if (args["set-default"]) {
      console.log("OpenClaw will use this account by default after the gateway is started/restarted.");
    } else {
      console.log("To make OpenClaw use this account by default, set this in the root .env and restart the gateway:");
      console.log(`  GOOGLE_WORKSPACE_CLI_CONFIG_DIR=${containerPath}`);
      console.log("  GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND=file");
    }
    console.log("");
    console.log("For one-off commands, run gws with GOOGLE_WORKSPACE_CLI_CONFIG_DIR pointing at this profile.");
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
