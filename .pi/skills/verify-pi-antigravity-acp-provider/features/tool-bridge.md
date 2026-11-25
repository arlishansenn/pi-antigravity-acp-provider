# Pi tool bridge

A Pi tool the model calls runs in Pi and its result returns to the model through the provider's loopback MCP bridge within the same Antigravity turn.

## Sub-features

- `bridge-call`: one tool call, one result, same turn.
- `bridge-parallel`: several tool calls from one inference resolve in one continuation.

## How to get to it (user POV)

- Ask an `antigravity-acp/*` session to call any Pi tool, such as `read` or an extension tool.

## Driving it with bin/verify.sh

Preconditions: `verify.sh doctor` passes.

- Run the real drive:
  - `.pi/skills/verify-pi-antigravity-acp-provider/bin/verify.sh steer-tool`
  - Observable result: `pi-events.jsonl` has an assistant `toolCall` for `verify_hold_and_steer` with the thinking line `[Antigravity tool: pi-bridge_pi_verify_hold_and_steer — in_progress]`, a `toolResult` with text `done`, and the drive ends with `PASS steer-tool` or a FAIL that still shows the result returned.
- Cover parallel calls at protocol level:
  - `npx vitest run test/runtime-safety.test.ts -t "parallel"`
  - Observable result: passed.

## Gotchas

- Tools the provider omits from the bridge never reach the model; `/antigravity-acp doctor` names them. The verification tool has no arguments and no special features, so it is never omitted.
