# pi-timer

Let the agent arm chat pings. One `timer` tool, seven actions:

| Action  | What it does                                                        |
| ------- | ------------------------------------------------------------------- |
| `in`    | one-shot after a delay — `delay`: `90s`, `5m`, `1h30m`, `2d`        |
| `at`    | one-shot at a wall-clock time — `at`: `14:30`, `2026-11-09 09:00`, ISO |
| `every` | recurring interval — `delay`, minimum 10s                           |
| `cron`  | recurring on a 5-field crontab — `cron`: `*/15 * * * *`             |
| `on`    | fire when a shell command exits — `command`, optional `expect` (`success`/`failure`/`any`), `matches` regex on output, `timeoutSec` (default 600) |
| `cancel`| cancel by id (`t3`) or label                                        |
| `list`  | list active timers                                                  |

A fire sends `[timer <id>] <message>` as a user message — a real turn when
the agent is idle, a queued follow-up while it is streaming. Every spawn
requires a **self-contained** `message`, because the agent of that moment has
no other context.

`on` pings exactly once when the command ends, saying whether the awaited
condition held and attaching a tail of its output (last 400 chars,
whitespace-collapsed) — a spawn is never silently dropped, even when the
condition did not hold or the command timed out.

## Chat examples

- "Remind me to check the oven in 45 minutes" → `timer in delay=45m`
- "Ping me when `npm run build` finishes" → `timer on command="npm run build"`
- "Every morning at 9, remind me to stand up" → `timer cron cron="0 9 * * *"`
- "Nudge me every 30 minutes until I commit" → `timer every delay=30m`
- "At 17:30 tell me to write the report" → `timer at at=17:30`

Manage timers yourself with `/timers` (list) and `/timers cancel t3`.

## Persistence

Timers are per-session and stored under `~/.pi/agent/timers/<session>.json`
(kept 30 days). On `session_start` future timers re-arm; recurring timers
skip cycles missed while Pi was closed; one-shots that expired while closed
are reported as missed and dropped. `on` watchers re-launch their command on
restart. Files for the current session are deleted when its last timer is
cancelled or fires.

## Install

```
pi install git:github.com/hakergeniusz/pi-timer
```

## Notes

- Recurring minimum is 10s to protect your context window.
- Max 64 active timers per session; message capped at 1000 chars.
- `on` runs commands via `sh -c` in the session cwd, aborted on cancel/shutdown.

MIT licensed. See [LICENSE](LICENSE).
