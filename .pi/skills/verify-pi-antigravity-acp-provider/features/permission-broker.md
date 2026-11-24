# Permission broker

In a prompting Antigravity permission mode, a native action the runtime wants to run appears in Pi as the tool call `antigravity_acp_permission`; Pi's answer returns to the runtime as the ACP permission response.

## Sub-features

- `permission-answer`: allow or reject once, continuation completes.
- `permission-steer`: a steer that arrives with the answer is held for the next prompt.

## How to get to it (user POV)

- Switch the provider to `default` or `auto-edit` with `/antigravity-acp`, then ask for a native command.

## Driving it with bin/verify.sh

Preconditions: none for the protocol-level recipe.

- Protocol-level only:
  - `npx vitest run test/steer-continuation.test.ts test/late-tool-result.test.ts`
  - Observable result: passed. The permission case in `steer-continuation.test.ts` asserts the ledger stops before the steer.

## Gotchas

- Pi print mode cannot answer a permission prompt, so there is no real-surface recipe yet.
