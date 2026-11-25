// Usage: node scripts/classify-corpus.mts <records.jsonl>
import fs from "node:fs";
import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import { classifyFailure } from "../src/acp/failure-classes.ts";

const file = process.argv[2];
if (!file) {
	console.error("usage: node scripts/classify-corpus.mts <records.jsonl>");
	process.exit(2);
}
interface CorpusRecord { split: "train" | "holdout"; stopReason: string; errorMessage: string; file: string; line: number }
const records: CorpusRecord[] = fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
const rows = new Map<string, { train: number; holdout: number; piDisagrees: number }>();
const unclassified: CorpusRecord[] = [];
for (const record of records) {
	const failure = classifyFailure(record.errorMessage);
	if (!failure) { unclassified.push(record); continue; }
	const row = rows.get(failure.id) ?? { train: 0, holdout: 0, piDisagrees: 0 };
	row[record.split] += 1;
	const piRetries = isRetryableAssistantError({ role: "assistant", stopReason: record.stopReason, errorMessage: record.errorMessage, content: [] } as never);
	if (piRetries !== failure.piRetryable) row.piDisagrees += 1;
	rows.set(failure.id, row);
}
for (const [id, row] of rows) console.log(`${id.padEnd(22)} train=${row.train} holdout=${row.holdout} piDisagreesOnRecordedText=${row.piDisagrees}`);
const bySplit = (split: string) => unclassified.filter((record) => record.split === split).length;
console.log(`unclassified train=${bySplit("train")} holdout=${bySplit("holdout")}`);
for (const record of unclassified) console.log(`  ${record.split} ${record.file}:${record.line} ${record.errorMessage.slice(0, 120).replace(/\s+/gu, " ")}`);
process.exit(bySplit("holdout") === 0 ? 0 : 1);
