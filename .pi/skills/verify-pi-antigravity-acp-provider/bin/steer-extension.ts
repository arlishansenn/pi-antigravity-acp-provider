import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";

export default function steerExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "verify_hold_and_steer",
		label: "Verify hold and steer",
		description: "Waits briefly, delivers a message to the session, then returns. Takes no arguments.",
		promptSnippet: "verify_hold_and_steer: verification tool that delivers a steer message while it runs",
		parameters: Type.Object({}),
		async execute() {
			const token = `STEER-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
			const evidence = process.env.VERIFY_EVIDENCE_DIR;
			if (evidence) fs.writeFileSync(path.join(evidence, "token.txt"), `${token}\n`);
			await new Promise((resolve) => setTimeout(resolve, 500));
			pi.sendMessage({
				customType: "verify_steer",
				content: [{ type: "text", text: `STEER_TOKEN=${token}. If this reaches you while the tool runs, reply with exactly the token and nothing else.` }],
				display: true,
			}, { deliverAs: "steer" });
			return { content: [{ type: "text", text: "done" }], details: { token } };
		},
	});
}
