# OpenClaw Workshop

This workshop runs a local OpenClaw deployment for Telegram, browser automation,
Google Workspace tooling, MTProto watcher jobs, and native Live Talk from a
Telegram Mini App.

The current Live Talk path is native OpenClaw. Telegram only launches and
identifies the user; the browser captures microphone audio and OpenClaw handles
the realtime session, transcripts, tool calls, and assistant audio.

## What You Need

1. Install Docker Desktop: https://www.docker.com/products/docker-desktop/
2. Create a Telegram bot with https://t.me/BotFather and put the token in `.env`.
3. Optional: create a Telegram app at https://my.telegram.org/apps for MTProto
   watcher skills, then put `TG_API_ID` and `TG_API_HASH` in `.env`.
4. Copy `.env.example` to `.env` and fill only the values you need.
5. Quit Chrome completely before first startup if you want browser automation.

Do not commit `.env`, OAuth files, Telegram sessions, or generated runtime state.

## Run It

From this directory:

```powershell
docker compose --profile mtproto up -d
```

Useful checks:

```powershell
docker compose --profile mtproto ps
docker compose logs -f openclaw-gateway
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:18789/healthz
```

The active Compose override currently pins OpenClaw services to the local image:

```text
openclaw-advanced-openclaw:live-talk-2026.5.22
```

If you change native OpenClaw code under `../imports/openclaw-source`, rebuild
that image and recreate the services before testing.

## Telegram Mini App Live Talk

The active Mini App flow is:

```text
Telegram bot menu
  -> https://<public-host>/talk
  -> native OpenClaw launch validation
  -> /talk/live?session=...&talkTransport=gateway-relay#launch=...
  -> /talk/launch/redeem
  -> gateway websocket
  -> talk.session.create / talk.session.appendAudio
```

Important routes:

- `/talk` starts the Telegram-authenticated launcher.
- `/talk/live` serves the lightweight native Mini App page.
- `/talk/launch/redeem` redeems a short-lived launch token.
- `/gemini/session` should stay inactive for the active Mini App path.

The Mini App frontend source lives outside this workshop repo:

```text
../imports/openclaw-source/src/gateway/talk-live-page.ts
```

The legacy `realtime-web` custom Gemini voice runtime is still present for
reference but is profile-gated as `legacy-realtime-web` in
`docker-compose.override.yml`. Do not start it for normal Live Talk testing.

## Use It

Open Telegram and message the configured bot. Text and voice notes can route
through OpenClaw. Examples:

- "What's on my calendar today?"
- "Open Gmail and tell me what's new"
- "Read my latest Instagram DMs"
- "Audit my call center"

For Live Talk, open the bot's Mini App/menu button. On a phone, the public HTTPS
host must route both page requests and WebSocket traffic to the OpenClaw gateway.
Approve microphone access in the Telegram WebView when prompted.

## MTProto Skills

When `TG_API_ID`, `TG_API_HASH`, and `TG_USER_SESSION` are configured, the
`tg-watcher` service enables MTProto-based workflows:

- A DM containing `meeet` can trigger meeting extraction and calendar creation.
- A DM containing `taskk` can trigger task extraction.
- Delegated chat workflows can route replies through Telegram automation.

Restart MTProto auth if the session expires:

```powershell
bash scripts/mtproto-setup.sh
```

## Google Workspace

Google Workspace CLI is vendored under:

```text
workspace/vendor/googleworkspace-cli/npm
```

The container path is exposed through:

```text
workspace/bin/gws
```

Google OAuth material under `workspace/.config/gws` is secret runtime state. Do
not print or commit it.

## Customize

- `workspace/USER.md` describes the user.
- `workspace/SOUL.md` tunes assistant personality.
- `workspace/TOOLS.md` documents service references.
- `config/openclaw.json` controls OpenClaw gateway, agents, channels, Talk, and TTS.
- `.env` controls local ports, Telegram credentials, provider keys, and runtime flags.

## Troubleshooting

- Chrome automation fails: quit all Chrome windows and restart the stack.
- Bot does not reply: check `docker compose logs -f openclaw-gateway`.
- Gateway is unavailable: check `docker compose --profile mtproto ps` and `/healthz`.
- MTProto watcher fails: refresh the session with `scripts/mtproto-setup.sh`.
- Port `18789` is busy: set `OPENCLAW_GATEWAY_PORT` in `.env` and recreate services.
- Mini App loads but audio does not start: test from the real Telegram phone
  WebView, approve microphone access, and confirm the HTTPS host supports
  WebSocket upgrades to the gateway.

## Privacy

Everything is designed to run locally in Docker with durable state mounted from
this workshop folder. Browser automation uses your host Chrome session through
the CDP bridge. Telegram sessions, OAuth files, provider keys, and gateway tokens
must remain local secrets.
