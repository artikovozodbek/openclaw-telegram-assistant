# AGENTS.md

## Project Context

This workshop is an OpenClaw deployment customized to run inside Docker with host-mounted durable state:

- Project root: `E:\Projects\OpenClawAdvanced\workshop`
- OpenClaw config mount: `./config -> /home/node/.openclaw`
- Workspace mount: `./workspace -> /home/node/.openclaw/workspace`
- Main compose file: `docker-compose.yml`
- Runtime secrets live in `.env`; never print or copy secret values into chat or memory files.

The goal of this deployment is to extend OpenClaw with Google Workspace automation and Telegram automation. The user prefers durable, code-level fixes over one-off container workarounds.

## Existing Agent Instructions

- `workspace/MEMORY.md` for long-term memory.
- `workspace/memory/YYYY-MM-DD.md` for daily session notes.

The Google Workspace CLI vendor copy has its own upstream-focused instructions at `workspace/vendor/googleworkspace-cli/AGENTS.md`. Those are for the vendored CLI project, not for the whole OpenClaw workshop.

## Skill Directory Structure

The project intentionally has multiple skill roots:

- `workspace/skills/`: durable custom/API/MCP skills. Telegram and Google
  Workspace live here.
- `workspace/.agents/skills/`: active legacy browser-service templates only.
- `workspace/.agents/skills-disabled/`: archived duplicate browser skills that
  must not be active.

Do not reactivate `gmail`, `google-calendar`, `google-meet`,
`google-analytics`, or `telegram-web` from `.agents/skills-disabled` unless the
user explicitly requests browser-first behavior. Active Google Workspace routing
uses `gws-*`; active Telegram routing uses `telegram` and `telegram-send`.

## Docker Runtime

As of 2026-05-20, the relevant default-compose containers were:

- `workshop-openclaw-gateway-1`: main OpenClaw gateway, healthy, ports `18789` and `18790`.
- `workshop-openclaw-cli-1`: CLI sidecar, healthy, shares the gateway network namespace.
- `workshop-cdp-proxy-1`: CDP proxy sidecar, running, shares the gateway network namespace.
- `workshop-tg-watcher-1`: MTProto Telegram watcher, profile-gated by `mtproto`; start it explicitly with `docker compose --profile mtproto up -d tg-watcher` when needed.
- `openclaw-gateway-custom`: custom gateway container outside the default compose update path; do not assume it is running unless Docker says so.

Useful checks:

```powershell
docker ps -a
docker inspect --format "{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}" workshop-openclaw-gateway-1
docker logs --tail 120 workshop-openclaw-gateway-1
```

When running workspace CLIs inside Docker, set the workspace PATH explicitly if using `docker exec` directly:

```powershell
docker exec workshop-openclaw-gateway-1 sh -lc 'PATH=/home/node/.openclaw/workspace/bin:/home/node/.openclaw/workspace/node_modules/.bin:$PATH gws --version'
```

## OpenClaw Image And Model Defaults

As of 2026-05-20, OpenClaw is intentionally configured to use the stable latest Docker image:

- `docker-compose.yml` uses `${OPENCLAW_IMAGE:-ghcr.io/openclaw/openclaw:latest}` for `openclaw-gateway`, `openclaw-cli`, `cdp-proxy`, and `tg-watcher`.
- Each OpenClaw service has `pull_policy: always`, so `docker compose up` checks GHCR before starting.
- `scripts/update.sh` and `scripts/update.bat` pull the same image and force-recreate the default gateway/CLI/CDP services.
- The active main gateway reported `OpenClaw 2026.5.18` after the 2026-05-20 update.

The default agent model must remain the user's custom provider, not Gemini:

- `config/openclaw.json` and `config-custom/openclaw.json` default to `celion/gpt-5.4`.
- The `celion` provider uses `api: "openai-responses"` at both provider and model levels.
- `thinkingDefault` is `high`.
- Gemini/Google keys may exist in `.env` for narrow media, TTS/Talk, or legacy skill use, but do not make Gemini the default agent model unless the user explicitly asks.

Active main Voice/TTS defaults as of 2026-05-20:

- `config/openclaw.json` sets `messages.tts.provider` to `google`, using `${GEMINI_API_KEY}`, `gemini-3.1-flash-tts-preview`, and voice `Kore`.
- `config/openclaw.json` sets `talk.provider` to `google` for Talk speech playback; `talk.realtime.provider` is also `google` with `gemini-3.1-flash-live-preview`.
- ElevenLabs remains configured as a fallback provider.

Provider env slots were corrected on 2026-05-13: `CELION_BASE_URL` is URL-shaped and `CELION_API_KEY` is key-shaped. Never print their values. Verification from the main gateway returned HTTP 200 from the Celion `/models` endpoint, and `openclaw models status --json` resolved the default model to `celion/gpt-5.4`.

## Google Workspace CLI Status

Google Workspace CLI is vendored under `workspace/vendor/googleworkspace-cli/npm` and exposed through `workspace/bin/gws`.

The original problem was Docker-specific:

- `workspace/node_modules/@googleworkspace/cli` can be a host-side symlink that points at a Windows or host path and is broken inside the Linux container.
- The vendored Linux GNU `gws` binary required `GLIBC_2.39`.
- The OpenClaw image uses Debian glibc `2.36`, so the GNU binary failed in the container.

Implemented fixes on 2026-05-13:

- `workspace/bin/gws` falls back to `workspace/vendor/googleworkspace-cli/npm/run.js`.
- `workspace/vendor/googleworkspace-cli/npm/platform.js` supports `GOOGLE_WORKSPACE_CLI_PLATFORM` override and chooses `x86_64-unknown-linux-musl` on Linux when glibc is older than 2.39.
- `workspace/vendor/googleworkspace-cli/npm/install.js` records `.platform`, smoke-tests the installed binary, and reinstalls when the version, platform, or smoke test is wrong.
- `workspace/vendor/googleworkspace-cli/npm/run.js` auto-installs when the vendored binary is missing or stale.

Verified after the fix:

```text
workshop-openclaw-gateway-1: gws 0.22.5
openclaw-gateway-custom: gws 0.22.5
```

Installed vendored metadata after repair:

```text
workspace/vendor/googleworkspace-cli/npm/bin/.platform = x86_64-unknown-linux-musl
workspace/vendor/googleworkspace-cli/npm/bin/.version = 0.22.5
```

OAuth status as of 2026-05-13:

- The user completed `gws auth login` from Windows using the durable config directory `workspace/.config/gws`.
- `.env` includes:
  - `GOOGLE_WORKSPACE_CLI_CONFIG_DIR=/home/node/.openclaw/workspace/.config/gws`
  - `GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND=file`
- Credential material exists under `workspace/.config/gws` (`client_secret.json`, `credentials.enc`, `.encryption_key`, token cache). Treat these as secrets: never print, copy, or record their contents.
- Host `gws auth status` reports OAuth2, encrypted storage, refresh token present, and token valid. The main gateway can validate the same credentials when the two env vars above are supplied; recreate services after `.env` changes so the running processes inherit them.
- First live Calendar check failed because the Google Calendar API is disabled in the OAuth project. Enable the needed Google APIs in Cloud Console before expecting workflows to work: Calendar, Gmail, Drive, and Sheets at minimum.

## Telegram Automation Status

Telegram automation is MCP-first for general Telegram tooling. The OpenClaw `telegram-mcp` server is configured on the main gateway and should be the primary tool surface for direct Telegram operations where it has the needed capability.

Telegram skill routing was expanded on 2026-05-14:

- `workspace/skills/telegram/SKILL.md` is the broad Telegram routing skill and must be read first for any Telegram request before browser automation or Telegram Web.
- `workspace/skills/telegram-send/SKILL.md` remains the fast path for simple one-off DMs to existing visible chats through `workspace/bin/tg-send`.
- Existing chats should be searched before contacts, and contacts before public/external lookup unless the user gives an exact `@username`.
- Use Telegram MCP for read/search/history, contacts, public lookup, replies, scheduled messages, media, groups/channels, moderation, and admin actions.
- Use Telegram Web/browser only when the user explicitly asks for the browser UI or direct Telegram tools are unavailable.

The MTProto watcher remains the real-time automation daemon for OpenClaw-specific trigger workflows. Do not disable or replace it until meeting scanner, task scanner, proxy-chat inbound routing, and send-as-CEO have equivalent MCP-backed behavior. Required `.env` variables exist but their values must remain secret:

- `TELEGRAM_BOT_TOKEN`
- `TG_API_ID`
- `TG_API_HASH`
- `TG_USER_SESSION`
- `CEO_TG_ID`
- `OPENCLAW_GATEWAY_TOKEN`

`TG_API_ID` and `TG_API_HASH` identify the Telegram API application. `TG_USER_SESSION` is the logged-in user session generated by the MTProto setup scripts. The user authenticated by QR code on 2026-05-13.

Setup scripts:

- Windows: `scripts/mtproto-setup.ps1`
- Unix: `scripts/mtproto-setup.sh`

Telegram MCP launcher repair was implemented on 2026-05-13: `workspace/bin/telegram-mcp-server.js` validates the Linux venv before using it and falls back to bundled `uv` with workspace-persisted Python install settings when the venv interpreter is missing or stale.

## Practical Rules For Future Sessions

- Do not expose `.env` values or Telegram session strings.
- For Telegram tasks, first read `workspace/skills/telegram/SKILL.md`; for simple one-off DMs also read `workspace/skills/telegram-send/SKILL.md`. Use direct MCP/MTProto routing over browser automation.
- Prefer persistent code changes in `workspace/` or scripts over manual edits inside a running container.
- Be careful with `workspace/node_modules`; it is ignored and may contain host-specific symlinks.
- Before changing Docker state, check the currently running containers and avoid deleting unrelated exited containers.
- This `workshop/` directory is a Git repository. After each completed phase, feature, or major coherent update, run the relevant checks, review `git status`, and commit the completed work.
- Stage only files intentionally changed for the task. Do not commit secrets, local runtime state, generated exports, dependency folders, or unrelated user changes.
- Use concise commit messages that name the phase or feature, for example `Implement official talk launcher phase 3`.
- Embedded vendor repositories under `workspace/vendor/googleworkspace-cli/` and `workspace/vendor/telegram-mcp/` are not tracked by the workshop repo; treat their Git state separately when a task explicitly changes them.
- The parent project root is not currently a Git repository; root-level files are outside the workshop Git repo unless the user says otherwise.
