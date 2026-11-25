# Upstream failure classes

When the Antigravity backend, agy's built-in proxy, OAuth, or the network fails, the provider ends the turn with a message that names the failure class, and Pi retries only the classes the table in `src/acp/failure-classes.ts` marks retryable. A sign-in page during session start is reported as sign-in required, never as a timeout.

## Sub-features

- `ccpa-read-timeout`: the generate stream stays silent; one silent agy request takes about 305 s, one provider attempt about 615 s.
- `ccpa-connection-reset`: the generate connection is reset; one provider attempt takes about 13 s.
- `ccpa-remote-closed`: the server closes the stream without a response.
- `login-required`: agy opens a Google sign-in page during `session/new`; Pi does not retry.

## How to get to it (user POV)

- Use an `antigravity-acp/*` model while the backend is slow, the network drops, or the stored Google login has expired.

## Driving it with bin/verify.sh

Preconditions: `verify.sh doctor` passes; `HTTPS_PROXY` points at the local upstream proxy when one is in use (`fault-run.sh` chains to it).

- Inject a fault on the real runtime:
  - `bin/fault-run.sh close daily-cloudcode-pa 18742` (about 1 minute), `bin/fault-run.sh swallow daily-cloudcode-pa 18743` (about 2 minutes), `TURN_TIMEOUT=750 bin/fault-run.sh stall daily-cloudcode-pa 18744` (about 12 minutes).
  - Observable result: `run.env` has the duration, `error-message.txt` has the final message, and `node --input-type=module -e 'import fs from "node:fs"; import { classifyFailure } from "./src/acp/failure-classes.ts"; console.log(classifyFailure(fs.readFileSync(process.argv[1], "utf8"))?.id)' <evidence>/error-message.txt` prints the expected class.
- Classify the session corpus:
  - `node scripts/error-corpus.mjs --out ~/.cache/pi-agy-error-corpus --holdout-since <ISO> ~/.pi/agent/sessions && node scripts/classify-corpus.mts ~/.cache/pi-agy-error-corpus/records.jsonl`
  - Observable result: `unclassified train=0 holdout=0` and exit code 0.
- Cover classes at protocol level:
  - `npx vitest run test/failure-classes.test.ts`
  - Observable result: all pass, including the sign-in case through a real connection to the fake agent.

## Gotchas

- `stall` keeps the client tunnel open after the server closes; `swallow` forwards the close and produces `ccpa-remote-closed` instead of a read timeout.
- Each real fault run spends model quota: Pi retries 3 times and agy sends 2 requests per attempt, so one run makes up to 8 requests.
- HTTP 503 and HTTP 429 cannot be injected through a CONNECT proxy; they need TLS interception and are covered only by recorded stderr.
- Session `errorMessage` keeps only a stderr tail, which can cut the `proxy_server.py` line the parser reads. Use raw stderr for parser fixtures.
