import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { AntigravityAcpConnection } from "../src/acp/connection.js";
import { AntigravityAcpError, errorMessage } from "../src/acp/errors.js";
import { findSessionSelector, sessionModels, sessionModes } from "../src/acp/session-state.js";

const fakeAgent = fileURLToPath(new URL("./fixtures/fake-agent.mjs", import.meta.url));

describe("AntigravityAcpConnection", () => {
	it("ignores known browser-launch stdout noise", async () => {
		const connection = new AntigravityAcpConnection({
			cwd: path.dirname(fakeAgent),
			command: process.execPath,
			args: [fakeAgent, "browser-noise"],
		});
		try {
			await expect(connection.initialize()).resolves.toMatchObject({
				agentInfo: { name: "fake-gemini" },
			});
			expect(connection.process.ignoredStdoutNoiseLines).toBe(1);
		} finally {
			await connection.close();
		}
	});

	it("marks the connection closed immediately upon close() even while the child process is alive", async () => {
		const connection = new AntigravityAcpConnection({
			cwd: path.dirname(fakeAgent),
			command: process.execPath,
			args: [fakeAgent],
		});
		const realClose = connection.process.close.bind(connection.process);
		let releaseClose!: () => void;
		const closeGate = new Promise<void>((resolve) => {
			releaseClose = resolve;
		});
		connection.process.close = async () => {
			await closeGate;
			await realClose();
		};
		try {
			await connection.initialize();
			expect(connection.closed).toBe(false);
			const closing = connection.close();
			expect(connection.closed).toBe(true);
			expect(connection.process.alive).toBe(true);
			releaseClose();
			await closing;
			expect(connection.process.alive).toBe(false);
		} finally {
			releaseClose?.();
			await realClose();
		}
	});

	it("marks the connection closed on protocol error", async () => {
		const connection = new AntigravityAcpConnection({
			cwd: path.dirname(fakeAgent),
			command: process.execPath,
			args: [fakeAgent, "malformed-output"],
			initializeTimeoutMs: 5_000,
		});
		try {
			await expect(connection.initialize()).rejects.toThrow("malformed JSON");
			expect(connection.closed).toBe(true);
		} finally {
			await connection.close();
		}
	});

	it("rejects malformed output without an unhandled SDK receive rejection", async () => {
		const connection = new AntigravityAcpConnection({
			cwd: path.dirname(fakeAgent),
			command: process.execPath,
			args: [fakeAgent, "malformed-output"],
			initializeTimeoutMs: 5_000,
		});
		try {
			await expect(connection.initialize()).rejects.toThrow("malformed JSON");
		} finally {
			await connection.close();
		}
		expect(connection.process.alive).toBe(false);
	});

	it("rejects promptly and quietly when the agent exits before a request", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const connection = new AntigravityAcpConnection({
			cwd: path.dirname(fakeAgent),
			command: process.execPath,
			args: [fakeAgent, "exit-after-initialize"],
			operationTimeoutMs: 5_000,
		});
		try {
			await connection.initialize();
			await connection.process.exited;
			const started = Date.now();
			const error = await connection.newSession(process.cwd()).catch((cause: unknown) => cause);
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).not.toContain("write after end");
			expect(Date.now() - started).toBeLessThan(500);
			expect(
				errorSpy.mock.calls.some((call) => String(call[0]).includes("ACP write error")),
			).toBe(false);
		} finally {
			errorSpy.mockRestore();
			await connection.close();
		}
	});

	it("reports a session timeout without leaking an unhandled rejection", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (error: unknown) => unhandled.push(error);
		process.on("unhandledRejection", onUnhandled);
		const connection = new AntigravityAcpConnection({
			cwd: path.dirname(fakeAgent),
			command: process.execPath,
			args: [fakeAgent, "session-timeout"],
			operationTimeoutMs: 25,
		});
		try {
			await connection.initialize();
			await expect(connection.newSession(process.cwd())).rejects.toThrow(
				"Antigravity ACP session/new timed out after 25ms",
			);
			await new Promise((resolve) => setTimeout(resolve, 25));
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
			await connection.close();
		}
	});

	it("includes safe structured details in ACP errors", async () => {
		const connection = new AntigravityAcpConnection({
			cwd: path.dirname(fakeAgent),
			command: process.execPath,
			args: [fakeAgent, "internal-error"],
		});
		try {
			await connection.initialize();
			const error = await connection.newSession(process.cwd()).catch((cause: unknown) => cause);
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toContain(
				"Internal error: Permission denied: localharness_external",
			);
			expect((error as Error).message).toContain("api_key=<redacted>");
			expect((error as Error).message).not.toContain("AIza1234567890abcdefghijkl");
		} finally {
			await connection.close();
		}
	});

	it("uses stable grouped config options for discovery, model/mode selection and restoration", async () => {
		const connection = new AntigravityAcpConnection({
			cwd: path.dirname(fakeAgent), command: process.execPath, args: [fakeAgent, "config-options"],
		});
		try {
			const session = await connection.newSession(process.cwd());
			expect(session.models).toBeUndefined();
			expect(sessionModels(session)?.availableModels).toEqual([
				{ modelId: "auto", name: "Auto" }, { modelId: "gemini-test", name: "Gemini Test" },
			]);
			await connection.setModel(session.sessionId, "gemini-test");
			await connection.setMode(session.sessionId, "yolo");
			const resumed = await connection.resumeSession(session.sessionId, process.cwd());
			expect(sessionModels(resumed)?.currentModelId).toBe("gemini-test");
			expect(sessionModes(resumed)?.currentModeId).toBe("yolo");
			const loaded = await connection.loadSession(session.sessionId, process.cwd());
			expect(sessionModels(loaded)?.currentModelId).toBe("gemini-test");
		} finally {
			await connection.close();
		}
	});

	it("rejects when changing the base model removes the thought_level selector before effort can be confirmed", async () => {
		const connection = new AntigravityAcpConnection({
			cwd: path.dirname(fakeAgent),
			command: process.execPath,
			args: [fakeAgent, "config-options-disappearing-thought"],
		});
		try {
			const session = await connection.newSession(process.cwd());
			await expect(connection.setModel(session.sessionId, "gemini-test-low")).rejects.toThrow(
				"Antigravity did not confirm the requested thought_level selection",
			);
		} finally {
			await connection.close();
		}
	});

	it("sends the base model id and the tier on the server's own selector", async () => {
		const connection = new AntigravityAcpConnection({
			cwd: path.dirname(fakeAgent), command: process.execPath, args: [fakeAgent, "effort-selector"],
		});
		try {
			const session = await connection.newSession(process.cwd());
			await connection.setModel(session.sessionId, "gemini-test-low");
			const state = connection.getSessionState(session.sessionId);
			expect(sessionModels(state)?.currentModelId).toBe("gemini-test-low");
			expect(findSessionSelector(state, "thought_level")?.currentValue).toBe("low");
		} finally {
			await connection.close();
		}
	});

	it("falls back to the draft set_model when the model selector ignores the id", async () => {
		const connection = new AntigravityAcpConnection({
			cwd: path.dirname(fakeAgent), command: process.execPath, args: [fakeAgent, "legacy-set-model"],
		});
		try {
			const session = await connection.newSession(process.cwd());
			await connection.setModel(session.sessionId, "gemini-test-high");
			const resumed = await connection.resumeSession(session.sessionId, process.cwd());
			expect(sessionModels(resumed)?.currentModelId).toBe("gemini-test-high");
		} finally {
			await connection.close();
		}
	});

	it.each(["stream progress", "native work"])("keeps an active %s turn alive beyond the idle budget", async (text) => {
		const connection = new AntigravityAcpConnection({ cwd: process.cwd(), command: process.execPath,
			args: [fakeAgent], env: { ...process.env, FAKE_PROGRESS_STEP_MS: "60" }, promptIdleTimeoutMs: 300, promptWorkIdleTimeoutMs: 1500 });
		try {
			const session = await connection.newSession(process.cwd());
			expect((await connection.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text }] })).stopReason).toBe("end_turn");
			expect(connection.process.alive).toBe(true);
		} finally { await connection.close(); }
	});

	it("bounds native tools that never report completion", async () => {
		const connection = new AntigravityAcpConnection({ cwd: process.cwd(), command: process.execPath,
			args: [fakeAgent], promptIdleTimeoutMs: 300, promptWorkIdleTimeoutMs: 600 });
		try {
			const session = await connection.newSession(process.cwd());
			await expect(connection.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "native stuck" }] })).rejects.toThrow("no tool/permission progress for 600ms");
			await connection.process.exited;
			expect(connection.process.alive).toBe(false);
		} finally { await connection.close(); }
	});

	it("holds a parked Pi call until release, then detects a silent prompt", async () => {
		const connection = new AntigravityAcpConnection({ cwd: process.cwd(), command: process.execPath,
			args: [fakeAgent], promptIdleTimeoutMs: 100, promptWorkIdleTimeoutMs: 1000 });
		try {
			const session = await connection.newSession(process.cwd());
			const pending = connection.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "hang" }] });
			const rejection = expect(pending).rejects.toThrow("no progress for 100ms");
			const release = connection.holdPromptWatchdog(session.sessionId);
			await new Promise((resolve) => setTimeout(resolve, 250));
			expect(connection.process.alive).toBe(true);
			release(); release(); await rejection;
		} finally { await connection.close(); }
	});

	it("surfaces redacted stderrTail on prompt watchdog and operation timeouts", async () => {
		const connection = new AntigravityAcpConnection({
			cwd: path.dirname(fakeAgent),
			command: process.execPath,
			args: [fakeAgent],
			promptIdleTimeoutMs: 40,
		});
		try {
			await connection.initialize();
			const session = await connection.newSession(process.cwd());
			connection.process.child.stderr.push(`${"startup-noise ".repeat(500)}\n`);
			connection.process.child.stderr.push(
				"W1122 21:28:15.000100 48213 proxy_server.py:222] Proxy failed to connect to CCPA API: Socket operation failed to CCPA API: The read operation timed out\n",
			);
			connection.process.child.stderr.push(`${"post-error-frame ".repeat(210)}\n`);
			connection.process.child.stderr.push(
				"WARNING: System step error (HTTP 502): The model is currently unreachable. api_key=AIza1234567890abcdefghijkl\n",
			);
			const error = await connection.prompt({
				sessionId: session.sessionId,
				prompt: [{ type: "text", text: "hang" }],
			}).catch((cause: unknown) => cause);
			expect(error).toBeInstanceOf(Error);
			const formatted = errorMessage(error);
			expect(formatted.length).toBeLessThanOrEqual(4_096);
			expect(formatted).toContain("Antigravity ACP session/prompt timed out: no progress for 40ms:");
			expect(formatted).toContain("Proxy failed to connect to CCPA API: Socket operation failed to CCPA API: The read operation timed out");
			expect(formatted).toContain("WARNING: System step error (HTTP 502): The model is currently unreachable.");
			expect(formatted).toContain("<redacted>");
			expect(formatted).not.toContain("AIza1234567890abcdefghijkl");
		} finally {
			await connection.close();
		}
	});

	describe("when agy silently retries 429 RESOURCE_EXHAUSTED", () => {
		const exhaustedAgent = (stepMs = 20) => new AntigravityAcpConnection({ cwd: process.cwd(), command: process.execPath,
			args: [fakeAgent, "resource-exhausted"], env: { ...process.env, FAKE_RETRY_STEP_MS: String(stepMs) } });
		const prompt = (connection: AntigravityAcpConnection, sessionId: string, text: string, signal?: AbortSignal) =>
			connection.prompt({ sessionId, prompt: [{ type: "text", text }] }, signal);

		it("fails the prompt fast with a redacted quota error", async () => {
			const connection = exhaustedAgent();
			try {
				const session = await connection.newSession(process.cwd());
				const started = Date.now();
				const error = await prompt(connection, session.sessionId, "Reply with exactly: PONG").catch((cause: unknown) => cause);
				expect(Date.now() - started).toBeLessThan(2_000);
				expect(error).toBeInstanceOf(AntigravityAcpError);
				expect((error as AntigravityAcpError).code).toBe("quota");
				expect((error as Error).message).toBe(
					"Antigravity quota exceeded: the model path refused requests with HTTP 429 RESOURCE_EXHAUSTED (rate limit or entitlement); agy retried 3 times, next retry in 10.74s, without a reply. Retry later or switch to another provider.",
				);
				await connection.process.exited;
				expect(connection.process.alive).toBe(false);
				expect(connection.process.stderrTail).toContain("access_token=<redacted>");
				expect(connection.process.stderrTail).not.toContain("ya29.fake-secret-access-token");
			} finally { await connection.close(); }
		});

		it.each([
			"retries 1",
			"retries 2",
			"retries 0 with the model name on stderr",
			"echo Error 429, Message: Resource has been exhausted (e.g. check quota)., Status: RESOURCE_EXHAUSTED retries 0",
		])("completes a turn that recovers: %s", async (text) => {
			const updates: string[] = [];
			const connection = exhaustedAgent();
			connection.setHandlers({ onUpdate: (notification) => { updates.push(notification.update.sessionUpdate); } });
			try {
				const session = await connection.newSession(process.cwd());
				expect((await prompt(connection, session.sessionId, text)).stopReason).toBe("end_turn");
				expect(updates).toEqual(["agent_message_chunk"]);
				expect(connection.process.alive).toBe(true);
			} finally { await connection.close(); }
		});

		it("starts the retry count over once the model streams an update", async () => {
			const updates: string[] = [];
			const connection = exhaustedAgent();
			connection.setHandlers({ onUpdate: (notification) => { updates.push(notification.update.sessionUpdate); } });
			try {
				const session = await connection.newSession(process.cwd());
				expect((await prompt(connection, session.sessionId, "retries 2 progress")).stopReason).toBe("end_turn");
				expect(updates).toEqual(["agent_thought_chunk", "agent_message_chunk"]);
			} finally { await connection.close(); }
		});

		it("starts the retry count over once agy asks for permission", async () => {
			const updates: string[] = [];
			let permissions = 0;
			const connection = exhaustedAgent();
			connection.setHandlers({
				onUpdate: (notification) => { updates.push(notification.update.sessionUpdate); },
				onPermission: async () => { permissions++; return { outcome: { outcome: "selected", optionId: "allow-once" } }; },
			});
			try {
				const session = await connection.newSession(process.cwd());
				expect((await prompt(connection, session.sessionId, "retries 2 permission")).stopReason).toBe("end_turn");
				expect(permissions).toBe(1);
				expect(updates).toEqual(["agent_message_chunk"]);
			} finally { await connection.close(); }
		});

		it("still cancels and closes an unresponsive agent within the abort grace", async () => {
			const connection = exhaustedAgent(1_000);
			const controller = new AbortController();
			try {
				const session = await connection.newSession(process.cwd());
				const pending = prompt(connection, session.sessionId, "Reply with exactly: PONG", controller.signal);
				await new Promise((resolve) => setTimeout(resolve, 1_100));
				const started = Date.now();
				controller.abort();
				const error = await pending.catch((cause: unknown) => cause);
				expect((error as AntigravityAcpError).code).toBe("aborted");
				await connection.process.exited;
				expect(Date.now() - started).toBeLessThan(3_500);
				expect(connection.process.alive).toBe(false);
			} finally { await connection.close(); }
		});
	});

	describe("when agy silently retries transient 5xx and 408 errors", () => {
		const unavailableAgent = (stepMs = 20, idleMs = 2_500) => new AntigravityAcpConnection({
			cwd: process.cwd(),
			command: process.execPath,
			args: [fakeAgent, "upstream-unavailable"],
			promptIdleTimeoutMs: idleMs,
			env: { ...process.env, FAKE_RETRY_STEP_MS: String(stepMs) },
		});
		const prompt = (connection: AntigravityAcpConnection, sessionId: string, text: string, signal?: AbortSignal) =>
			connection.prompt({ sessionId, prompt: [{ type: "text", text }] }, signal);

		it("fails the prompt fast on the second 5xx retry with upstream cause and keeps the latest redacted stderrTail", async () => {
			const connection = unavailableAgent();
			try {
				const session = await connection.newSession(process.cwd());
				const started = Date.now();
				const error = await prompt(connection, session.sessionId, "proxy-timeout Reply with exactly: PONG").catch((cause: unknown) => cause);
				expect(Date.now() - started).toBeLessThan(1_500);
				expect(error).toBeInstanceOf(AntigravityAcpError);
				expect((error as AntigravityAcpError).code).toBe("model");
				const formatted = errorMessage(error);
				expect(formatted.length).toBeLessThanOrEqual(4_096);
				expect(formatted).toContain(
					"Antigravity model service temporarily unavailable (HTTP 502): Bad Gateway: Failed to connect to backend API; Proxy failed to connect to CCPA API: Socket operation failed to CCPA API: The read operation timed out; agy retried 2 times, next retry in 5.22s, without a reply:",
				);
				expect(formatted).toContain("access_token=<redacted>");
				expect(formatted).toContain("Encountered retryable api error. retrying in 5.217655808s");
				expect(formatted).not.toContain("ya29.fake-secret-access-token");
				await connection.process.exited;
				expect(connection.process.alive).toBe(false);
				expect(connection.process.stderrTail).toContain("Error 502, Message: Bad Gateway");
				expect(connection.process.stderrTail).toContain("access_token=<redacted>");
				expect(connection.process.stderrTail).not.toContain("ya29.fake-secret-access-token");
			} finally { await connection.close(); }
		});

		it("completes a turn that recovers from a single transient 502 retry", async () => {
			const updates: string[] = [];
			const connection = unavailableAgent();
			connection.setHandlers({ onUpdate: (notification) => { updates.push(notification.update.sessionUpdate); } });
			try {
				const session = await connection.newSession(process.cwd());
				expect((await prompt(connection, session.sessionId, "retries 1")).stopReason).toBe("end_turn");
				expect(updates).toEqual(["agent_message_chunk"]);
				expect(connection.process.alive).toBe(true);
			} finally { await connection.close(); }
		});

		it("recovers from a 305s slow-read 502 when the single retry streams after 45s", async () => {
			const connection = new AntigravityAcpConnection({
				cwd: path.dirname(fakeAgent),
				command: process.execPath,
				args: [fakeAgent],
			});
			let promptId: string | number | undefined;
			connection.process.onStderrLine((line) => {
				const match = /^hanging-prompt-id:(.+)$/u.exec(line);
				if (match) promptId = Number.isNaN(Number(match[1])) ? match[1] : Number(match[1]);
			});
			try {
				const session = await connection.newSession(process.cwd());
				vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
				const pending = prompt(connection, session.sessionId, "hang-emit-id");
				while (promptId === undefined) await new Promise((resolve) => setImmediate(resolve));

				vi.advanceTimersByTime(305_000);
				connection.process.child.stderr.push(
					"W1122 21:28:15.000100 48213 proxy_server.py:222] Proxy failed to connect to CCPA API: Socket operation failed to CCPA API: The read operation timed out\n" +
					"I1122 21:28:15.000200 48213 local_connection.py:553] Error 502, Message: Bad Gateway: Failed to connect to backend API, Status: 502 Bad Gateway, Details: []\n" +
					"I1122 21:28:15.000300 48213 planner_generator.go:359] Encountered retryable api error. retrying in 4s\n",
				);
				await new Promise((resolve) => setImmediate(resolve));

				vi.advanceTimersByTime(49_000);
				connection.process.child.stdout.push(
					`${JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: session.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "HEALED" } } } })}\n` +
					`${JSON.stringify({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } })}\n`,
				);
				expect((await pending).stopReason).toBe("end_turn");
				expect(connection.process.alive).toBe(true);
			} finally {
				vi.useRealTimers();
				await connection.close();
			}
		});

		it("surfaces structured 502 cause on consecutive 305s slow-read timeouts instead of a blind 600s watchdog timeout", async () => {
			const connection = new AntigravityAcpConnection({
				cwd: path.dirname(fakeAgent),
				command: process.execPath,
				args: [fakeAgent],
			});
			let promptId: string | number | undefined;
			connection.process.onStderrLine((line) => {
				const match = /^hanging-prompt-id:(.+)$/u.exec(line);
				if (match) promptId = Number.isNaN(Number(match[1])) ? match[1] : Number(match[1]);
			});
			try {
				const session = await connection.newSession(process.cwd());
				connection.process.child.stderr.push(`${"loadCodeAssist ".repeat(500)}\n`);
				vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
				let settled = false;
				const pending = prompt(connection, session.sessionId, "hang-emit-id").finally(() => { settled = true; });
				void pending.catch(() => undefined);
				while (promptId === undefined) await new Promise((resolve) => setImmediate(resolve));

				vi.advanceTimersByTime(305_000);
				connection.process.child.stderr.push(
					"W1122 21:28:15.000100 48213 proxy_server.py:222] Proxy failed to connect to CCPA API: Socket operation failed to CCPA API: The read operation timed out\n" +
					"I1122 21:28:15.000200 48213 local_connection.py:553] Error 502, Message: Bad Gateway: Failed to connect to backend API, Status: 502 Bad Gateway, Details: []\n" +
					"I1122 21:28:15.000300 48213 planner_generator.go:359] Encountered retryable api error. retrying in 4s\n",
				);
				await new Promise((resolve) => setImmediate(resolve));

				vi.advanceTimersByTime(309_000);
				await new Promise((resolve) => setImmediate(resolve));
				expect(settled).toBe(false);

				connection.process.child.stderr.push(
					"W1122 21:33:24.000100 48213 proxy_server.py:222] Proxy failed to connect to CCPA API: Socket operation failed to CCPA API: The read operation timed out\n" +
					"I1122 21:33:24.000200 48213 local_connection.py:553] Error 502, Message: Bad Gateway: Failed to connect to backend API, Status: 502 Bad Gateway, Details: []\n" +
					"I1122 21:33:24.000300 48213 planner_generator.go:359] Encountered retryable api error. retrying in 5.77s\n",
				);
				const error = await pending.catch((cause: unknown) => cause);
				expect(error).toBeInstanceOf(AntigravityAcpError);
				expect((error as AntigravityAcpError).code).toBe("model");
				const formatted = errorMessage(error);
				expect(formatted).toContain("HTTP 502");
				expect(formatted).toContain("The read operation timed out");
				expect(formatted).toContain("agy retried 2 times, next retry in 5.77s");
			} finally {
				vi.useRealTimers();
				await connection.close();
			}
		});

		it("lets the accepted retry window outlive a shorter promptIdleTimeoutMs and preserves long structured ACP error tails", async () => {
			const connection = new AntigravityAcpConnection({
				cwd: path.dirname(fakeAgent),
				command: process.execPath,
				args: [fakeAgent],
				promptIdleTimeoutMs: 60_000,
			});
			let promptId: string | number | undefined;
			connection.process.onStderrLine((line) => {
				const match = /^hanging-prompt-id:(.+)$/u.exec(line);
				if (match) promptId = Number.isNaN(Number(match[1])) ? match[1] : Number(match[1]);
			});
			try {
				const session = await connection.newSession(process.cwd());
				vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
				let settled = false;
				const pending = prompt(connection, session.sessionId, "hang-emit-id").finally(() => { settled = true; });
				void pending.catch(() => undefined);
				while (promptId === undefined) await new Promise((resolve) => setImmediate(resolve));

				vi.advanceTimersByTime(10_000);
				connection.process.child.stderr.push(
					"I1122 21:28:15.000200 48213 local_connection.py:553] Error 502, Message: Bad Gateway: Failed to connect to backend API, Status: 502 Bad Gateway, Details: []\n" +
					"I1122 21:28:15.000300 48213 planner_generator.go:359] Encountered retryable api error. retrying in 4s\n",
				);
				await new Promise((resolve) => setImmediate(resolve));

				vi.advanceTimersByTime(120_000);
				await new Promise((resolve) => setImmediate(resolve));
				expect(settled).toBe(false);

				connection.process.child.stderr.push(
					"W1122 21:33:15.000100 48213 proxy_server.py:222] Proxy failed to connect to CCPA API: Socket operation failed to CCPA API: Remote end closed connection without response\n",
				);
				await new Promise((resolve) => setImmediate(resolve));
				vi.advanceTimersByTime(214_000);
				const error = await pending.catch((cause: unknown) => cause);
				expect(error).toBeInstanceOf(AntigravityAcpError);
				expect((error as AntigravityAcpError).code).toBe("model");
				const formatted = errorMessage(error);
				expect(formatted).toContain("Remote end closed connection without response");
				expect(formatted).toContain("agy retried 1 time, next retry in 4s, without a reply");
			} finally {
				vi.useRealTimers();
				await connection.close();
			}

			const structuredConn = new AntigravityAcpConnection({
				cwd: path.dirname(fakeAgent),
				command: process.execPath,
				args: [fakeAgent],
			});
			let secondPromptId: string | number | undefined;
			structuredConn.process.onStderrLine((line) => {
				const match = /^hanging-prompt-id:(.+)$/u.exec(line);
				if (match) secondPromptId = Number.isNaN(Number(match[1])) ? match[1] : Number(match[1]);
			});
			try {
				const session = await structuredConn.newSession(process.cwd());
				const pending = prompt(structuredConn, session.sessionId, "hang-emit-id");
				void pending.catch(() => undefined);
				while (secondPromptId === undefined) await new Promise((resolve) => setImmediate(resolve));
				structuredConn.process.child.stdout.push(
					`${JSON.stringify({
						jsonrpc: "2.0",
						id: secondPromptId,
						error: {
							code: -32603,
							message: "Internal error",
							data: {
								details: `${"trace-frame ".repeat(450)}\nproxy_server.py:222] Proxy failed to connect to CCPA API: Remote end closed connection\nAPI_ERROR: HTTP 502 Bad Gateway`,
							},
						},
					})}\n`,
				);
				const structuredError = await pending.catch((cause: unknown) => cause);
				const formatted = errorMessage(structuredError);
				expect(formatted.length).toBeLessThanOrEqual(4_096);
				expect(formatted).toContain("Antigravity ACP error -32603: Internal error:");
				expect(formatted).toContain("proxy_server.py:222] Proxy failed to connect to CCPA API: Remote end closed connection");
				expect(formatted).toContain("API_ERROR: HTTP 502 Bad Gateway");
			} finally {
				await structuredConn.close();
			}
		});

		it("resets the transient retry count on streaming updates and permission requests", async () => {
			const updates: string[] = [];
			let permissions = 0;
			const connection = unavailableAgent();
			connection.setHandlers({
				onUpdate: (notification) => { updates.push(notification.update.sessionUpdate); },
				onPermission: async () => { permissions++; return { outcome: { outcome: "selected", optionId: "allow-once" } }; },
			});
			try {
				const session = await connection.newSession(process.cwd());
				expect((await prompt(connection, session.sessionId, "retries 1 progress")).stopReason).toBe("end_turn");
				expect((await prompt(connection, session.sessionId, "retries 1 permission")).stopReason).toBe("end_turn");
				expect(permissions).toBe(1);
				expect(updates).toEqual(["agent_thought_chunk", "agent_message_chunk", "agent_message_chunk"]);
			} finally { await connection.close(); }
		});
	});

	it("rejects invalid inactivity options before starting a child", () => {
		expect(() => new AntigravityAcpConnection({ cwd: process.cwd(), command: process.execPath, args: [fakeAgent], promptIdleTimeoutMs: Infinity })).toThrow(RangeError);
	});

	it("uses the official SDK against a real child process", async () => {
		const updates: string[] = [];
		const connection = new AntigravityAcpConnection({
			cwd: path.dirname(fakeAgent),
			command: process.execPath,
			args: [fakeAgent],
			handlers: {
				onUpdate: (notification) => {
					updates.push(notification.update.sessionUpdate);
				},
			},
		});
		try {
			const initialize = await connection.initialize();
			expect(initialize.agentInfo?.name).toBe("fake-gemini");
			await connection.authenticate({ methodId: "api", _meta: { "api-key": "secret" } });
			const session = await connection.newSession(process.cwd());
			expect(session.models?.availableModels).toHaveLength(2);
			await connection.setModel(session.sessionId, "gemini-test");
			const response = await connection.prompt({
				sessionId: session.sessionId,
				prompt: [{ type: "text", text: "hello" }],
			});
			expect(response.stopReason).toBe("end_turn");
			expect(updates).toEqual(["agent_thought_chunk", "agent_message_chunk"]);
		} finally {
			await connection.close();
		}
		expect(connection.process.alive).toBe(false);
	});
});
