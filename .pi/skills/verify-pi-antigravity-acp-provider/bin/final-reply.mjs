import fs from "node:fs";

const file = process.argv[2];
if (!file) {
	console.error("usage: final-reply.mjs <pi-events.jsonl>");
	process.exit(2);
}
let last;
for (const line of fs.readFileSync(file, "utf8").split("\n")) {
	if (!line.trim()) continue;
	const event = JSON.parse(line);
	if (event.type === "message_end" && event.message?.role === "assistant") last = event.message;
}
const content = last?.content ?? [];
process.stdout.write(content.filter((block) => block.type === "text").map((block) => block.text).join("\n"));
