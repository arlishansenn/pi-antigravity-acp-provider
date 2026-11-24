# Mid-turn steer delivery

A message Pi appends with `deliverAs: "steer"` while the model's turn is still open, such as a pi-herdr-agents `subagent_result`, a pi-bg-tasks completion notice, or a user typing mid-turn, reaches the model in the same turn when it arrives together with a Pi tool result, and reaches it on the next prompt when it arrives together with a permission answer. It is never dropped silently.

## Sub-features

- `steer-tool`: steer appended after a Pi tool result. The model sees it with the tool result in the same turn.
- `steer-parallel`: steer appended after several parallel tool results. Attached once, to the last result.
- `steer-permission`: steer appended after a permission answer. Held out of the ledger; the next prompt carries it as the current request.

## How to get to it (user POV)

- Run a subagent from a session whose model is `antigravity-acp/*` and let it finish while the parent is executing a tool call.
- Finish a `pi-bg-tasks` background task while the session is executing a tool call.
- Type a message into the TUI while the session is executing a tool call.

## Driving it with bin/verify.sh

Preconditions: `verify.sh doctor` passes; the account is logged in to the runtime.

- Run the real drive:
  - `MODEL=antigravity-acp/gemini-3.8-flash .pi/skills/verify-pi-antigravity-acp-provider/bin/verify.sh steer-tool`
  - Observable result: `PASS steer-tool: reply carries the steer token STEER-...`. `pi-events.jsonl` shows, in order, the assistant `toolCall` for `verify_hold_and_steer`, the `toolResult` `done`, a `custom` message with `customType: verify_steer`, then an assistant text that equals the token in `token.txt`.
- Prove the harness detects the bug on an unfixed build:
  - `VERIFY_REPO_ROOT=/path/to/checkout@main .pi/skills/verify-pi-antigravity-acp-provider/bin/verify.sh steer-tool`
  - Observable result on a build without the fix: `FAIL steer-tool: reply lacks steer token ...` and `pi-final-reply.txt` reads `NO_STEER`.
- Cover the permission path at protocol level:
  - `npx vitest run test/steer-continuation.test.ts`
  - Observable result: 4 passed. The permission case asserts the ledger stops before the steer and the next prompt carries it.

## Gotchas

- The token is minted inside the tool and never appears in the prompt, so a reply can carry it only if the steer was delivered. Do not move the token into the prompt.
- A model that ignores the tool call and answers from the prompt alone produces a FAIL with no `token.txt`; read `pi-events.jsonl` before blaming the provider.
- The real drive covers the tool path only. Pi print mode cannot answer a permission prompt, so `steer-permission` has no real-surface recipe.
