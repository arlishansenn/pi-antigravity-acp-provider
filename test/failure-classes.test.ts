import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AntigravityAcpConnection } from "../src/acp/connection.js";
import { AntigravityAcpError } from "../src/acp/errors.js";
import { classifyFailure, FAILURE_CLASSES } from "../src/acp/failure-classes.js";
import { ModelRetryState } from "../src/acp/quota.js";

type FixtureKind = "agy-stderr" | "agy-stderr-tail" | "provider-message";
interface Fixture { class: string; kind: FixtureKind; source: string; text: string }

const fakeAgent = fileURLToPath(new URL("./fixtures/fake-agent.mjs", import.meta.url));
const fixtures: Fixture[] = JSON.parse(fs.readFileSync(new URL("./fixtures/upstream-errors.json", import.meta.url), "utf8"));
const WITHOUT_REAL_SAMPLE = ["quota-exhausted"];
const piRetries = (errorMessage: string) =>
	isRetryableAssistantError({ role: "assistant", stopReason: "error", errorMessage, content: [] } as never);
const byId = (id: string) => FAILURE_CLASSES.find((failure) => failure.id === id)!;

function exhaust(stderr: string, attempts: number) {
	const state = new ModelRetryState();
	for (let attempt = 0; attempt < attempts; attempt++) {
		for (const line of stderr.split("\n")) {
			const step = state.noteStderrLine(line);
			if (step.kind === "exhausted") return step.failure;
		}
	}
	return undefined;
}

describe("upstream failure classes on real agy output", () => {
	it("has a real fixture for every class that has occurred", () => {
		const expected = FAILURE_CLASSES.map((failure) => failure.id).filter((id) => !WITHOUT_REAL_SAMPLE.includes(id));
		expect(new Set(fixtures.map((fixture) => fixture.class))).toEqual(new Set(expected));
	});

	it.each(fixtures.filter((fixture) => fixture.kind !== "provider-message"))(
		"turns $class stderr ($kind) into a final message in the same class with Pi's retry decision from the table",
		(fixture) => {
			const failure = exhaust(fixture.text, fixture.kind === "agy-stderr" ? 1 : 2);
			if (!failure) throw new Error(`${fixture.class}: stderr never exhausted the retry budget`);
			expect(classifyFailure(failure.message)?.id).toBe(fixture.class);
			expect(piRetries(failure.message)).toBe(byId(fixture.class).piRetryable);
			const hint = byId(fixture.class).hint;
			if (hint) expect(failure.message).toContain(hint);
		},
	);

	it.each(fixtures.filter((fixture) => fixture.kind === "provider-message" && fixture.class !== "login-required"))(
		"keeps Pi's retry decision for the recorded $class message",
		(fixture) => {
			expect(classifyFailure(fixture.text)?.id).toBe(fixture.class);
			expect(piRetries(fixture.text)).toBe(byId(fixture.class).piRetryable);
		},
	);

	it("reports a sign-in page during session/new as sign-in required, which Pi does not retry", async () => {
		const recorded = fixtures.find((fixture) => fixture.class === "login-required")!;
		expect(classifyFailure(recorded.text)?.id).toBe("login-required");
		const connection = new AntigravityAcpConnection({
			cwd: path.dirname(fakeAgent), command: process.execPath,
			args: [fakeAgent, "session-login-required"], operationTimeoutMs: 200,
		});
		try {
			await connection.initialize();
			const error = await connection.newSession(process.cwd()).catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(AntigravityAcpError);
			const { code, message } = error as AntigravityAcpError;
			expect(code).toBe("auth");
			expect(classifyFailure(message)?.id).toBe("login-required");
			expect(message).toContain("/login");
			expect(message).not.toContain("state=");
			expect(piRetries(message)).toBe(false);
		} finally {
			await connection.close();
		}
	});
});
