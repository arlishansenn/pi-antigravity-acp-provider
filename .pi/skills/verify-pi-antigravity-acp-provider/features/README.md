# pi-antigravity-acp-provider verification map

This directory is the maintained source for verifying the user-facing behavior of the `antigravity-acp` provider. Read the index before driving, then use the matching feature file as the recipe. Driven means a recipe in this skill ran it against the real Pi CLI and the real Antigravity ACP runtime.

| Feature | Entry point | Status |
| --- | --- | --- |
| [Model turn](model-turn.md) | `pi -p --model antigravity-acp/<id> "..."` | protocol-level only (`npm run test:live`) |
| [Pi tool bridge](tool-bridge.md) | a Pi tool the model calls | driven by `verify.sh steer-tool` |
| [Mid-turn steer](mid-turn-steer.md) | a steer message arriving with a tool result | driven by `verify.sh steer-tool` |
| [Permission broker](permission-broker.md) | `antigravity_acp_permission` tool call | protocol-level only (`test/steer-continuation.test.ts`) |
| [Session restore](session-restore.md) | `pi --continue` after a restart | protocol-level only (`test/session-store*.test.ts`) |

## Baseline preconditions

- A checkout with `npm ci` done. `VERIFY_REPO_ROOT` selects it; the default is the checkout this skill lives in.
- `pi` and `node` on `PATH`. The managed runtime at `~/.local/opt/agy-acp/current/agy_acp_server.par` or `AGY_ACP_BIN`.
- A logged-in Google account for the runtime. `verify.sh doctor` does not check login; a drive fails with an auth error in `pi-stderr.log` when it is missing.
- Run `verify.sh doctor` and require `PASS doctor` before any drive.

## Driving conventions

- Start every recipe from a fresh Pi process in a scratch directory. Never attach to the operator's live `~/.pi/agent/sessions` tree; every drive passes `--session-dir` under the evidence directory.
- Treat every command as literal. Keep quoted names and flags unchanged.
- Each drive spends real model turns. Do not loop a drive to make it pass; read the evidence.

## Proof and skip reporting

- CLI proof includes `run.env`, `pi-events.jsonl`, `pi-final-reply.txt`, and the pass line.
- Record the feature ID and entry point with every artifact.
- Report an unreachable path with the attempted command and the unmet precondition. Do not report a protocol-level test as a real-surface drive.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior, then four H2 sections in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with bin/verify.sh`, and `Gotchas`.
