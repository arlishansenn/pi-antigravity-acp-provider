#!/usr/bin/env bash
# Usage: fault-run.sh <pass|stall|swallow|close> <host-regex> <port> [threshold-bytes]
set -euo pipefail
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="${VERIFY_REPO_ROOT:-$(cd "$SKILL_DIR/../../.." && pwd)}"
MODE="$1"; MATCH="$2"; PORT="$3"; THRESHOLD="${4:-16384}"
MODEL="${MODEL:-antigravity-acp/gemini-3.8-flash}"
UPSTREAM="${FAULT_UPSTREAM:-${HTTPS_PROXY:-}}"
EVIDENCE="${VERIFY_EVIDENCE_ROOT:-$HOME/.cache/verify-pi-antigravity-acp-provider}/fault-$MODE-$(date +%Y%m%d-%H%M%S)-$$"
mkdir -p "$EVIDENCE/sessions"
node "$SKILL_DIR/bin/fault-proxy.mjs" --port "$PORT" --log "$EVIDENCE/proxy.jsonl" --mode "$MODE" --match "$MATCH" \
	--threshold "$THRESHOLD" ${UPSTREAM:+--upstream "$UPSTREAM"} &
PROXY_PID=$!
trap 'kill "$PROXY_PID" 2>/dev/null || true' EXIT
sleep 1
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/verify-agy-fault-XXXXXX")"
START=$(date +%s)
set +e
(cd "$SCRATCH" && PI_ANTIGRAVITY_ACP_PROXY="http://127.0.0.1:$PORT" timeout "${TURN_TIMEOUT:-1800}" pi -p --mode json --no-extensions \
	-e "$REPO_ROOT/extensions/index.ts" --model "$MODEL" --session-dir "$EVIDENCE/sessions" \
	"Reply with exactly: FAULT_PROBE_OK" > "$EVIDENCE/pi-events.jsonl" 2> "$EVIDENCE/pi-stderr.log")
EXIT=$?
set -e
END=$(date +%s)
rm -rf "$SCRATCH"
node "$SKILL_DIR/bin/final-reply.mjs" "$EVIDENCE/pi-events.jsonl" > "$EVIDENCE/pi-final-reply.txt"
ERROR="$(node -e 'const fs=require("fs");let m="";for(const l of fs.readFileSync(process.argv[1],"utf8").split("\n")){if(!l.trim())continue;const e=JSON.parse(l);if(e.type==="message_end"&&e.message?.role==="assistant"&&e.message.errorMessage)m=e.message.errorMessage}process.stdout.write(m)' "$EVIDENCE/pi-events.jsonl")"
printf '%s' "$ERROR" > "$EVIDENCE/error-message.txt"
printf 'mode=%s match=%s threshold=%s model=%s repo_head=%s pi_exit=%s seconds=%s\n' "$MODE" "$MATCH" "$THRESHOLD" "$MODEL" \
	"$(git -C "$REPO_ROOT" rev-parse --short HEAD)" "$EXIT" "$((END - START))" | tee "$EVIDENCE/run.env"
echo "faults=$(grep -c '"kind":"fault"' "$EVIDENCE/proxy.jsonl" || true) error=$(head -c 200 "$EVIDENCE/error-message.txt" | tr '\n' ' ')"
echo "reply=$(head -c 120 "$EVIDENCE/pi-final-reply.txt" | tr '\n' ' ')"
echo "evidence=$EVIDENCE"
