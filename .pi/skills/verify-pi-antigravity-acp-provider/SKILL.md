---
name: verify-pi-antigravity-acp-provider
description: "Drive a pi-antigravity-acp-provider checkout through the real Pi CLI and the real Antigravity ACP runtime: doctor checks, a Pi tool round trip with a mid-turn steer message, and evidence under ~/.cache/verify-pi-antigravity-acp-provider. Use to prove provider behavior end to end (model turns, MCP tool bridge, steer delivery) after changing src/runtime.ts or src/stream, before opening a PR, or when a bug report mentions lost mid-turn messages, subagent_result, or background-task notices."
---

# Verify pi-antigravity-acp-provider

Surface: the Pi CLI with the provider loaded from a checkout (`pi --no-extensions -e ./extensions/index.ts`) talking to the managed Antigravity ACP runtime. One drive is one real model turn pair; it spends Antigravity quota. Feature map: [features/README.md](features/README.md).

Every step runs through `bin/verify.sh`. Run it from any directory. `VERIFY_REPO_ROOT` points it at another checkout, which is how a run proves the harness detects a bug on an unfixed build.

## Launch

No server. Each drive starts its own short-lived `pi -p` process in a scratch directory and waits for it. Install dependencies once per checkout.

```sh
npm ci                       # in the checkout
VERIFY_REPO_ROOT=/path/to/checkout .pi/skills/verify-pi-antigravity-acp-provider/bin/verify.sh all
```

`all` runs doctor, `steer-tool`, then `cleanup`, and exits non-zero on any FAIL. `MODEL=antigravity-acp/<id>` overrides the model (default `antigravity-acp/gemini-3.8-flash`). `PI_BIN` overrides the Pi executable. `TURN_TIMEOUT` bounds one drive in seconds (default 300).

## Doctor

```sh
.pi/skills/verify-pi-antigravity-acp-provider/bin/verify.sh doctor
```

Read-only, no model turn. Checks `pi` and `node` on PATH, the provider entry `extensions/index.ts` and the steer extension exist, `node_modules` is installed, the ACP runtime is present (`AGY_ACP_BIN` or `~/.local/opt/agy-acp/current/agy_acp_server.par`), and the provider lists the model through `pi --list-models`. Run it first and after any failed drive.

## Drive

- `verify.sh steer-tool`: a fresh print-mode Pi session loads the provider and `bin/steer-extension.ts`, which registers the tool `verify_hold_and_steer`. The prompt asks the model to call that tool once and then reply with the `STEER_TOKEN` value of any message that reached it while the tool ran. The tool mints a random token, writes it to `token.txt` in the evidence directory, delivers it through `pi.sendMessage(..., { deliverAs: "steer" })`, and returns `done`. That is the shape pi-herdr-agents uses for `subagent_result` and pi-bg-tasks for completion notices. The token exists only in the steer message, so a reply that carries it proves the provider delivered the steer to the model in the same turn. `NO_STEER` or any reply without the token is a FAIL. Details in [features/mid-turn-steer.md](features/mid-turn-steer.md).

## Evidence

Each run writes to `~/.cache/verify-pi-antigravity-acp-provider/<timestamp>-<pid>/`. The path of the latest run is in `~/.cache/verify-pi-antigravity-acp-provider/latest`.

- `run.env` holds the checkout path, its HEAD, the model, the Pi version, and the scratch directory.
- `token.txt` holds the token the tool delivered. Its absence means the tool never ran.
- `pi-events.jsonl` holds the print-mode event stream: the tool call, the `toolResult`, the `custom` message with `customType: verify_steer`, and the final assistant message.
- `pi-final-reply.txt` holds the extracted final assistant text.
- `pi-stderr.log` holds provider and runtime stderr.
- `sessions/` holds the Pi session files written through `--session-dir`.

A PASS needs the token in the reply. The model saying it received a message is not evidence.

## Cleanup

```sh
.pi/skills/verify-pi-antigravity-acp-provider/bin/verify.sh cleanup [EVIDENCE=<dir>]
```

Kills only the Pi PID recorded in `pids` (and its children) if it is still alive, removes the scratch directory named in `run.env`, and keeps every evidence file. Never kill by process name. The drive removes its scratch directory itself when Pi exits; cleanup covers interrupted runs.

## Helpers

- `bin/verify.sh`: doctor, steer-tool, cleanup, all.
- `bin/steer-extension.ts`: Pi extension that registers `verify_hold_and_steer`. Loaded with `-e`; never installed.
- `bin/final-reply.mjs <pi-events.jsonl>`: prints the final assistant text from a print-mode event stream.
- `bin/fault-proxy.mjs` and `bin/fault-run.sh <pass|stall|swallow|close> <host-regex> <port>`: inject a fault on one upstream host in front of the real runtime. See [features/upstream-failures.md](features/upstream-failures.md).

## Gotchas

- A run spends two real model turns. Point `MODEL` at a cheap model unless the feature needs another.
- Hook-like behavior in the provider never reaches an already running Pi session; every drive starts a fresh process, so a checkout edit is picked up by the next run.
- `--no-extensions` drops every other extension, including pi-bg-tasks and pi-herdr-agents. That is intentional: the steer arrives from the verification tool, not from a side effect of another extension.
- The permission broker has no real-surface drive yet. Pi in print mode cannot answer a permission prompt, so that path is covered at protocol level by `test/steer-continuation.test.ts` only.
