# Session restore

A Pi session that used an `antigravity-acp/*` model resumes its warm Antigravity ACP session after a Pi restart, so the next prompt sends only the unseen delta.

## Sub-features

- `restore-warm`: `pi --continue` reuses the saved ACP session id and ledger.
- `restore-stale`: a changed history prefix or instructions rebuild the session.

## How to get to it (user POV)

- Exit Pi, restart it in the same directory, run `pi --continue`, send a prompt.

## Driving it with bin/verify.sh

Preconditions: none for the protocol-level recipe.

- Protocol-level only:
  - `npx vitest run test/session-store.test.ts test/session-store-concurrency.test.ts test/runtime-safety.test.ts -t "restor"`
  - Observable result: passed.

## Gotchas

- The ledger is keyed by Pi session id and stored under the real HOME; a drive that isolates HOME starts cold.
