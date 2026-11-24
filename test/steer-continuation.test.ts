import type { Context, Model, ToolResultMessage } from "@earendil-works/pi-ai";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { AntigravityAcpConnection } from "../src/acp/connection.js";
import { AcpSessionStore } from "../src/acp/session-store.js";
import { AntigravityRuntime, PERMISSION_RESULT_KIND, PERMISSION_TOOL_NAME } from "../src/runtime.js";
import type { PiEventWriter } from "../src/stream/pi-events.js";

const fakeAgent = fileURLToPath(new URL("./fixtures/fake-agent.mjs", import.meta.url));
const model: Model<"antigravity-acp"> = {
	id: "gemini-test", name: "Test", api: "antigravity-acp", provider: "antigravity-acp",
	baseUrl: "", reasoning: false, input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 8192,
};
const tools = [{ name: "echo", description: "Echo", parameters: Type.Object({ text: Type.String() }) }];
const SYSTEM_HEAD = 1;
const roots: string[] = [];
const runtimes: AntigravityRuntime[] = [];
afterEach(async () => {
	await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

type Call = Extract<Context["messages"][number], { role: "assistant" }>["content"][number] & { type: "toolCall" };
type Reply = Awaited<ReturnType<typeof drain>>;

function setup() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-steer-")); roots.push(root);
	const log = path.join(root, "calls.jsonl"); fs.writeFileSync(log, "");
	const store = new AcpSessionStore(path.join(root, "sessions.json"));
	const runtime = new AntigravityRuntime((options) => new AntigravityAcpConnection({
		...options, command: process.execPath, args: [fakeAgent],
		env: { ...process.env, FAKE_AGENT_LOG_FILE: log },
	}), "default", store);
	runtimes.push(runtime);
	const acpPrompts = () => fs.readFileSync(log, "utf8").split("\n").filter(Boolean)
		.map((line) => JSON.parse(line) as { method: string; prompt?: Array<{ type: string; text?: string; resource?: { text: string } }> })
		.filter((entry) => entry.method === "session/prompt")
		.map((entry) => (entry.prompt ?? []).map((block) => block.type === "text" ? block.text ?? "" : block.resource?.text ?? "").join("\n"));
	const acpLedger = (sessionId: string) => store.get(sessionId)?.messageCount;
	return { runtime, acpPrompts, acpLedger };
}
async function drain(writer: PiEventWriter) { for await (const _event of writer.stream) void _event; return writer.message; }
const user = (content: string, timestamp: number): Context["messages"][number] => ({ role: "user", content, timestamp });
const acpEcho = (message: Reply) => message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
function result(call: Call, body: string, timestamp: number, details?: ToolResultMessage["details"]): ToolResultMessage {
	return { role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: body }], isError: false, timestamp, ...(details ? { details } : {}) };
}
function calls(message: Reply): Call[] { return message.content.filter((block): block is Call => block.type === "toolCall"); }
const allow = (call: Call): ToolResultMessage => result(call, "Allowed", 3, { kind: PERMISSION_RESULT_KIND, requestId: call.id, optionId: "allow-once", cancelled: false });
const STEER = "STEER_MARKER subagent_result: focus-ui-2 finished and reported";

describe("mid-turn steer arriving in the same continuation as tool or permission results", () => {
	it.each([
		["use bridge", 1],
		["use bridge parallel", 2],
		["bridge and permission", 1],
	] as const)("delivers the steer with the %s tool result and never resends it", async (request, echoCalls) => {
		const { runtime, acpPrompts, acpLedger } = setup();
		const options = { sessionId: "steer-tool", apiKey: "test-key" };
		const first = await drain(runtime.stream(model, { tools, messages: [user(request, 1)] }, options));
		expect(first.stopReason).toBe("toolUse");
		const echoes = calls(first).filter((call) => call.name === "echo");
		const permission = calls(first).find((call) => call.name === PERMISSION_TOOL_NAME);
		expect(echoes).toHaveLength(echoCalls);
		const answers = echoes.map((call, index) => result(call, `echo-${index}`, 2));
		if (permission) answers.push(allow(permission));

		const beforeSteer = [user(request, 1), first, ...answers];
		const steer = user(STEER, 4);
		const continued = await drain(runtime.stream(model, { tools, messages: [...beforeSteer, steer] }, options));
		expect(continued.stopReason).toBe("stop");
		for (const answer of answers.filter((entry) => entry.toolName === "echo")) expect(acpEcho(continued)).toContain((answer.content[0] as { text: string }).text);
		expect(acpEcho(continued).split(STEER)).toHaveLength(2);
		expect(acpLedger("steer-tool")).toBe(SYSTEM_HEAD + [...beforeSteer, steer].length);

		const next = await drain(runtime.stream(model, { tools, messages: [...beforeSteer, steer, continued, user("next turn", 5)] }, options));
		expect(next.stopReason).toBe("stop");
		expect(acpPrompts()).toHaveLength(2);
		expect(acpPrompts()[1]).toContain("next turn");
		expect(acpPrompts()[1]).not.toContain(STEER);
	});

	it("keeps a steer that rides with a permission-only answer out of the ledger until the next prompt delivers it", async () => {
		const { runtime, acpPrompts, acpLedger } = setup();
		const options = { sessionId: "steer-perm", apiKey: "test-key" };
		const first = await drain(runtime.stream(model, { tools, messages: [user("use permission", 1)] }, options));
		expect(first.stopReason).toBe("toolUse");
		const permission = calls(first).find((call) => call.name === PERMISSION_TOOL_NAME);
		if (!permission) throw new Error(`expected a permission call, got ${JSON.stringify(first.content)}`);

		const beforeSteer = [user("use permission", 1), first, allow(permission)];
		const steer = user(STEER, 4);
		const continued = await drain(runtime.stream(model, { tools, messages: [...beforeSteer, steer] }, options));
		expect(continued.stopReason).toBe("stop");
		expect(acpEcho(continued)).toContain("Decision: selected");
		expect(acpLedger("steer-perm")).toBe(SYSTEM_HEAD + beforeSteer.length);

		const next = await drain(runtime.stream(model, { tools, messages: [...beforeSteer, steer, continued, user("next turn", 5)] }, options));
		expect(next.stopReason).toBe("stop");
		expect(acpPrompts()).toHaveLength(2);
		expect(acpPrompts()[1]).toContain(STEER);
		expect(acpPrompts()[1]).toContain("next turn");
		expect(acpPrompts()[1]).not.toContain(acpEcho(continued));
		expect(acpLedger("steer-perm")).toBe(SYSTEM_HEAD + [...beforeSteer, steer, continued, user("next turn", 5)].length);
	});

	it("delivers each result once across two sequential tool calls in one turn", async () => {
		const { runtime } = setup();
		const options = { sessionId: "steer-seq", apiKey: "test-key" };
		const request = user("use bridge sequential", 1);
		const first = await drain(runtime.stream(model, { tools, messages: [request] }, options));
		expect(first.stopReason).toBe("toolUse");
		const firstResult = result(calls(first)[0]!, "echo-0", 2);
		const second = await drain(runtime.stream(model, { tools, messages: [request, first, firstResult] }, options));
		expect(second.stopReason).toBe("toolUse");
		const secondResult = result(calls(second)[0]!, "echo-1", 3);
		const final = await drain(runtime.stream(model, { tools, messages: [request, first, firstResult, second, secondResult] }, options));
		expect(final.stopReason).toBe("stop");
		expect(acpEcho(final)).toBe("echo-0||echo-1");
	});

	it("delivers a steer that rides the first of two sequential results once", async () => {
		const { runtime } = setup();
		const options = { sessionId: "steer-seq-steer", apiKey: "test-key" };
		const request = user("use bridge sequential", 1);
		const first = await drain(runtime.stream(model, { tools, messages: [request] }, options));
		const firstResult = result(calls(first)[0]!, "echo-0", 2);
		const steer = user(STEER, 3);
		const second = await drain(runtime.stream(model, { tools, messages: [request, first, firstResult, steer] }, options));
		expect(second.stopReason).toBe("toolUse");
		const secondResult = result(calls(second)[0]!, "echo-1", 4);
		const final = await drain(runtime.stream(model, { tools, messages: [request, first, firstResult, steer, second, secondResult] }, options));
		expect(final.stopReason).toBe("stop");
		const [firstEcho, secondEcho] = acpEcho(final).split("||");
		expect(firstEcho?.split(STEER)).toHaveLength(2);
		expect(secondEcho).toBe("echo-1");
	});
});
