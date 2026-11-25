#!/usr/bin/env node
// Usage: node scripts/error-corpus.mjs --out <dir> [--holdout-since <ISO>] <sessions-dir>...
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const roots = [];
let out;
let holdoutSince;
for (let index = 0; index < args.length; index++) {
	if (args[index] === "--out") out = args[++index];
	else if (args[index] === "--holdout-since") holdoutSince = Date.parse(args[++index]);
	else roots.push(args[index]);
}
if (!out || roots.length === 0 || (holdoutSince !== undefined && Number.isNaN(holdoutSince))) {
	console.error("usage: error-corpus.mjs --out <dir> [--holdout-since <ISO>] <sessions-dir>...");
	process.exit(2);
}

function* sessionFiles(dir) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) yield* sessionFiles(full);
		else if (entry.name.endsWith(".jsonl")) yield full;
	}
}

function signature(message) {
	const head = message.split(/;? agy retried \d+ times?/u)[0];
	return head
		.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu, "<id>")
		.replace(/\b[0-9a-f]{16,}\b/giu, "<id>")
		.replace(/\d+(?:\.\d+)?/gu, "<n>")
		.replace(/\s+/gu, " ")
		.trim()
		.slice(0, 240);
}

const records = [];
const seenSessions = new Set();
for (const root of roots) {
	for (const file of sessionFiles(root)) {
		const text = fs.readFileSync(file, "utf8");
		if (!text.includes("\"antigravity-acp\"")) continue;
		const entries = text.split("\n").filter(Boolean).map((line, line_) => ({ ...JSON.parse(line), line: line_ + 1 }));
		const sessionId = entries[0]?.type === "session" ? entries[0].id : file;
		if (seenSessions.has(sessionId)) continue;
		seenSessions.add(sessionId);
		const retriedIds = new Map(entries.filter((entry) => entry.type === "context_edit").map((entry) => [entry.targetId, entry]));
		entries.forEach((entry, index) => {
			const message = entry.message;
			if (entry.type !== "message" || message?.role !== "assistant" || message.provider !== "antigravity-acp") return;
			if (message.stopReason !== "error" && message.stopReason !== "aborted") return;
			const retryEdit = retriedIds.get(entry.id);
			const next = entries.slice(index + 1).find((candidate) =>
				candidate.type === "message" && (candidate.message?.role === "assistant" || candidate.message?.role === "user"));
			const retryOutcome = !retryEdit ? "not-retried"
				: next?.message?.role !== "assistant" ? "user-intervened"
				: next.message.stopReason === "error" ? "failed-again"
				: next.message.stopReason === "aborted" ? "aborted" : "recovered";
			const startedAt = message.timestamp;
			const endedAt = Date.parse(entry.timestamp);
			records.push({
				file, line: entry.line, sessionId, entryId: entry.id,
				model: message.model, stopReason: message.stopReason,
				startedAt: new Date(startedAt).toISOString(), durationMs: endedAt - startedAt,
				split: holdoutSince !== undefined && startedAt >= holdoutSince ? "holdout" : "train",
				retryOutcome,
				signature: signature(message.errorMessage ?? ""),
				errorMessage: message.errorMessage ?? "",
			});
		});
	}
}

const clusters = new Map();
for (const record of records) {
	const cluster = clusters.get(record.signature) ?? { signature: record.signature, train: 0, holdout: 0, durations: [], outcomes: {} };
	cluster[record.split] += 1;
	cluster.durations.push(record.durationMs);
	cluster.outcomes[record.retryOutcome] = (cluster.outcomes[record.retryOutcome] ?? 0) + 1;
	clusters.set(record.signature, cluster);
}
const median = (values) => {
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.floor(sorted.length / 2)];
};
const summary = [...clusters.values()]
	.map(({ durations, ...cluster }) => ({ ...cluster, count: durations.length, medianSeconds: Math.round(median(durations) / 1000), maxSeconds: Math.round(Math.max(...durations) / 1000) }))
	.sort((left, right) => right.count - left.count);

fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "records.jsonl"), records.map((record) => JSON.stringify(record)).join("\n") + "\n");
fs.writeFileSync(path.join(out, "clusters.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(`sessions=${seenSessions.size} records=${records.length} clusters=${summary.length} out=${out}`);
