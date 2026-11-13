# Performance notes

## How it was measured

- Same three test prompts each time (plain chat, weather lookup, Telegram digest), fresh
  sessions, run inside the gateway container with `openclaw agent --json`
  (`meta.durationMs`, `systemPromptReport`, gateway `prep stages` trace).
- CPU profile of the running gateway through the Node inspector for one turn
  (Profiler domain, 0.5 ms sampling), aggregated by self time and by call chain.

## Findings

1. **Prompt size:** a one-word message sent ~40k tokens: 57 tool schemas (78k chars) plus
   instruction/memory files that were already being truncated at 20k chars each.
2. **Agent preparation, not the model:** the model answered in ~2.3 s, but the agent spent
   5–9 s preparing every turn (`agent-session` stage).
3. **File system:** the profile showed most main-thread time in synchronous `lstat`/`stat`
   calls via path-safety helpers; the workspace was a Windows 9p bind mount
   (`cache=0`, ~1.5 ms per metadata call, ~270x slower than the container's ext4).

## Changes

| Change | Effect |
|---|---|
| `tools.deny` for 26 unused tools | tool schemas 78k → 51k chars |
| Trimmed `AGENTS.md`, moved old history out of `MEMORY.md` | system prompt 72k → 38k chars |
| Workspace moved to a Docker volume | removes slow metadata calls from every turn |
| `fast-lane` plugin (`before_agent_reply`) | plain chat answered in ~1.5–3 s |
| OpenClaw upgrade to 2026.11 | session preparation and prompt-cache fixes |

## Fast lane design

- Runs only for the owner's direct sessions, user-triggered turns.
- A regex pre-filter sends obvious tasks (send, search, open, weather, files, Telegram…)
  straight to the agent, with no model call.
- Otherwise one streamed call with a strict router prompt: answer only plain conversation,
  otherwise reply `AGENT`. Errors and timeouts fall back to the agent.
- Persona comes from `IDENTITY.md` / `SOUL.md` / `USER.md`, the conversation context from
  a short in-memory history.
- Known trade-off: fast-lane exchanges are not written to the agent's transcript.
