# Model turn

A prompt sent to an `antigravity-acp/*` model streams text, thinking, usage, and a stop reason back into Pi like any other provider.

## Sub-features

- `turn-plain`: one prompt, one reply, `end_turn`.
- `turn-reasoning`: the Shift+Tab thinking level selects the effort tier.

## How to get to it (user POV)

- Pick an `antigravity-acp/*` model with `/model` and send a prompt.

## Driving it with bin/verify.sh

Preconditions: `verify.sh doctor` passes; the account is logged in.

- Protocol-level only today:
  - `PI_ANTIGRAVITY_ACP_LIVE=1 npx vitest run test/live-authenticated.test.ts`
  - Observable result: passed, and the reply contains `ANTIGRAVITY_ACP_LIVE_OK`.
- The `steer-tool` drive exercises a real turn as a side effect; its `pi-final-reply.txt` is the reply text.

## Gotchas

- A live run needs the runtime logged in; an auth failure lands in the ACP stderr, not in the reply.
