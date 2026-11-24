#!/usr/bin/env bash
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="${VERIFY_REPO_ROOT:-$(cd "$SKILL_DIR/../../.." && pwd)}"
EVIDENCE_ROOT="${VERIFY_EVIDENCE_ROOT:-$HOME/.cache/verify-pi-antigravity-acp-provider}"
MODEL="${MODEL:-antigravity-acp/gemini-3.8-flash}"
PI_BIN="${PI_BIN:-pi}"
TURN_TIMEOUT="${TURN_TIMEOUT:-300}"
PROMPT='Call the tool verify_hold_and_steer once and wait for it. After it returns, if a message reached you while the tool was running, reply with exactly its STEER_TOKEN value and nothing else. Otherwise reply NO_STEER.'

usage() { echo "usage: verify.sh doctor | steer-tool | cleanup [EVIDENCE=<dir>] | all"; exit 2; }
doctor() {
	local ok=0 runtime
	command -v "${PI_BIN}" >/dev/null 2>&1 || { echo "FAIL doctor: ${PI_BIN} not on PATH"; ok=1; }
	command -v node >/dev/null 2>&1 || { echo "FAIL doctor: node not on PATH"; ok=1; }
	[ -f "$REPO_ROOT/extensions/index.ts" ] || { echo "FAIL doctor: $REPO_ROOT/extensions/index.ts missing"; ok=1; }
	[ -f "$SKILL_DIR/bin/steer-extension.ts" ] || { echo "FAIL doctor: $SKILL_DIR/bin/steer-extension.ts missing"; ok=1; }
	[ -d "$REPO_ROOT/node_modules" ] || { echo "FAIL doctor: run npm ci in $REPO_ROOT first"; ok=1; }
	runtime="${AGY_ACP_BIN:-$HOME/.local/opt/agy-acp/current/agy_acp_server.par}"
	[ -f "$runtime" ] || { echo "FAIL doctor: ACP runtime not found at $runtime"; ok=1; }
	echo "pi: $(${PI_BIN} --version 2>/dev/null | head -1)"
	echo "node: $(node --version)"
	echo "repo: $REPO_ROOT ($(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo no-git))"
	echo "runtime: $runtime"
	if [ "$ok" = 0 ]; then
		if (cd "$REPO_ROOT" && "${PI_BIN}" --no-extensions -e ./extensions/index.ts --list-models "${MODEL#*/}" 2>/dev/null) \
			| grep -Eq "^antigravity-acp[[:space:]]+${MODEL#*/}"; then
			echo "model: $MODEL listed by the provider"
		else
			echo "FAIL doctor: $MODEL not listed by the provider"; ok=1
		fi
	fi
	[ "$ok" = 0 ] && echo "PASS doctor" || echo "FAIL doctor"
	return "$ok"
}

steer_tool() {
	mkdir -p "$EVIDENCE_ROOT"
	local evidence="$EVIDENCE_ROOT/$(date +%Y%m%d-%H%M%S)-$$"
	mkdir -p "$evidence/sessions"
	echo "$evidence" > "$EVIDENCE_ROOT/latest"
	local scratch
	scratch="$(mktemp -d "${TMPDIR:-/tmp}/verify-agy-steer-XXXXXX")"
	{
		echo "repo=$REPO_ROOT"
		echo "repo_head=$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo no-git)"
		echo "model=$MODEL"
		echo "pi_version=$("${PI_BIN}" --version 2>/dev/null | head -1)"
		echo "scratch=$scratch"
	} > "$evidence/run.env"
	local token_file="$evidence/token.txt"
	rm -f "$token_file"
	(
		cd "$scratch"
		VERIFY_EVIDENCE_DIR="$evidence" timeout "$TURN_TIMEOUT" "${PI_BIN}" -p --mode json --no-extensions \
			-e "$REPO_ROOT/extensions/index.ts" -e "$SKILL_DIR/bin/steer-extension.ts" --model "$MODEL" \
			--session-dir "$evidence/sessions" "$PROMPT" > "$evidence/pi-events.jsonl" 2> "$evidence/pi-stderr.log"
	) &
	local pid=$!
	echo "$pid" > "$evidence/pids"
	wait "$pid" || echo "pi_exit=$?" >> "$evidence/run.env"
	rm -rf "$scratch"
	local token reply
	token="$(tr -d '\n' < "$token_file" 2>/dev/null || true)"
	reply="$(node "$SKILL_DIR/bin/final-reply.mjs" "$evidence/pi-events.jsonl")"
	printf '%s\n' "$reply" > "$evidence/pi-final-reply.txt"
	if [ -z "$token" ]; then
		echo "FAIL steer-tool: verify_hold_and_steer never ran (no token written); see $evidence"
		return 1
	fi
	if grep -qF "$token" <<< "$reply"; then
		echo "PASS steer-tool: reply carries the steer token $token; evidence $evidence"
		return 0
	fi
	echo "FAIL steer-tool: reply lacks steer token $token; evidence $evidence"
	echo "  reply: $(head -c 300 "$evidence/pi-final-reply.txt" | tr '\n' ' ')"
	return 1
}

cleanup() {
	local evidence="${EVIDENCE:-$(cat "$EVIDENCE_ROOT/latest" 2>/dev/null || true)}"
	if [ -z "$evidence" ] || [ ! -d "$evidence" ]; then echo "nothing to clean up"; return 0; fi
	local pid child
	if [ -f "$evidence/pids" ]; then
		while read -r pid; do
			[ -n "$pid" ] || continue
			if kill -0 "$pid" 2>/dev/null; then
				for child in $(pgrep -P "$pid" 2>/dev/null || true); do kill "$child" 2>/dev/null || true; done
				kill "$pid" 2>/dev/null || true
			fi
		done < "$evidence/pids"
	fi
	local scratch
	scratch="$(sed -n 's/^scratch=//p' "$evidence/run.env" 2>/dev/null || true)"
	case "$scratch" in "${TMPDIR:-/tmp}"/verify-agy-steer-*) rm -rf "$scratch" ;; esac
	echo "cleaned up processes and scratch dir from $evidence; evidence kept"
}

case "${1:-}" in
	doctor) doctor ;;
	steer-tool) steer_tool ;;
	cleanup) cleanup ;;
	all)
		ok=0
		doctor || ok=1
		steer_tool || ok=1
		cleanup
		exit "$ok"
		;;
	*) usage ;;
esac
