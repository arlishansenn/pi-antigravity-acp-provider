import type { SessionNotification } from "@agentclientprotocol/sdk/unstable";
import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PromptWatchdog } from "../src/acp/prompt-watchdog.js";
import {
	MODEL_RETRY_STARTUP_MARGIN_MS,
	MODEL_RETRY_UNPARSED_DELAY_MS,
	quotaExhaustion,
} from "../src/acp/quota.js";

const now = Date.UTC(2026, 9, 30, 12, 0);
const notice = (reset = "") => `Usage Limit Reached\n\nYou have reached your current quota for this period.${reset}`;

describe("quotaExhaustion", () => {
	it("adds a relative reset to now", () => {
		expect(quotaExhaustion(notice(" Your limit will reset in 4 days, 23 hours."), now))
			.toEqual({ resetAt: new Date(now + 119 * 3_600_000).toISOString() });
		expect(quotaExhaustion(notice(" Your limit will reset in 1 hour."), now))
			.toEqual({ resetAt: new Date(now + 3_600_000).toISOString() });
		expect(quotaExhaustion(notice(" Your limit will reset in 2 minutes, 1 second."), now))
			.toEqual({ resetAt: new Date(now + 121_000).toISOString() });
	});

	it("parses an absolute UTC reset", () => {
		expect(quotaExhaustion(notice(" Your limit will reset on Oct 2, 2026 14:00 UTC."), now))
			.toEqual({ resetAt: "2026-10-02T14:00:00.000Z" });
	});

	it("matches the notice without a reset sentence", () => {
		expect(quotaExhaustion(notice(), now)).toEqual({});
		expect(quotaExhaustion(`\n${notice()}\n`, now)).toEqual({});
	});

	it("ignores other text", () => {
		expect(quotaExhaustion("Hello", now)).toBeUndefined();
		expect(quotaExhaustion("Usage Limit Reached", now)).toBeUndefined();
		expect(quotaExhaustion(`${notice()} Anything else.`, now)).toBeUndefined();
		expect(quotaExhaustion(notice(" Your limit will reset in soon."), now)).toBeUndefined();
	});
});

const exhausted = "W1114 22:07:04.512301 48213 local_connection.py:553] Error 429, Message: Resource has been exhausted (e.g. check quota)., Status: RESOURCE_EXHAUSTED";
const retry = (delay: string) => `I1114 22:07:04.512398 48213 planner_generator.go:359] Encountered retryable api error. retrying in ${delay}`;

describe("ModelRetryState via PromptWatchdog", () => {
	afterEach(() => vi.useRealTimers());
	const transientLine = (status: number) =>
		`W1122 13:34:56.000100 48213 local_connection.py:553] Error ${status}, Message: Bad Gateway: Failed to connect to backend API`;
	const progressChunk: SessionNotification = {
		sessionId: "s",
		update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } },
	};

	function tracker() {
		vi.useFakeTimers();
		const onFailure = vi.fn();
		const watch = new PromptWatchdog(600_000, 3_600_000, (failure) => {
			if (failure.kind === "retry") onFailure({ code: failure.code, message: failure.message });
		});
		watch.arm();
		return {
			track: {
				noteStderrLine: (line: string) => watch.noteStderrLine(line),
				noteProgress: () => watch.noteUpdate(progressChunk),
				dispose: () => watch.dispose(),
			},
			onFailure,
		};
	}

	it("tolerates two 429 retries and fails on the third", () => {
		const { track, onFailure } = tracker();
		track.noteStderrLine(exhausted); track.noteStderrLine(retry("4s"));
		track.noteStderrLine(exhausted); track.noteStderrLine(retry("7.26s"));
		expect(onFailure).not.toHaveBeenCalled();
		track.noteStderrLine(exhausted); track.noteStderrLine(retry("10.74s"));
		expect(onFailure).toHaveBeenCalledExactlyOnceWith({
			code: "quota",
			message: "Antigravity quota exceeded: the model path refused requests with HTTP 429 RESOURCE_EXHAUSTED (rate limit or entitlement); agy retried 3 times, next retry in 10.74s, without a reply. Retry later or switch to another provider.",
		});
		track.noteStderrLine(exhausted); track.noteStderrLine(retry("25.89s"));
		expect(onFailure).toHaveBeenCalledTimes(1);
		track.dispose();
	});

	it("accepts the error and the retry on one line", () => {
		const { track, onFailure } = tracker();
		for (let i = 0; i < 3; i++) track.noteStderrLine(`${retry("500ms")}: ${exhausted}`);
		expect(onFailure).toHaveBeenCalledExactlyOnceWith({
			code: "quota",
			message: expect.stringContaining("agy retried 3 times, next retry in 0.5s"),
		});
		track.dispose();
	});

	it("fails at once when the announced retry delays pass 15 s", () => {
		const { track, onFailure } = tracker();
		track.noteStderrLine(exhausted); track.noteStderrLine(retry("1m2.5s"));
		expect(onFailure).toHaveBeenCalledExactlyOnceWith({
			code: "quota",
			message: expect.stringContaining("agy retried 1 time, next retry in 62.5s"),
		});
		track.dispose();
	});

	it("fails when two announced delays together pass 15 s", () => {
		const { track, onFailure } = tracker();
		track.noteStderrLine(exhausted); track.noteStderrLine(retry("10s"));
		expect(onFailure).not.toHaveBeenCalled();
		track.noteStderrLine(exhausted); track.noteStderrLine(retry("5.001s"));
		expect(onFailure).toHaveBeenCalledExactlyOnceWith({
			code: "quota",
			message: expect.stringContaining("agy retried 2 times, next retry in 5s"),
		});
		track.dispose();
	});

	it("lets a turn recover after two retries even when the first update comes late", () => {
		const { track, onFailure } = tracker();
		track.noteStderrLine(exhausted); track.noteStderrLine(retry("4s"));
		vi.advanceTimersByTime(4_000);
		track.noteStderrLine(exhausted); track.noteStderrLine(retry("7.26s"));
		vi.advanceTimersByTime(7_260 + 8_000);
		expect(onFailure).not.toHaveBeenCalled();
		track.noteProgress();
		vi.advanceTimersByTime(60_000);
		expect(onFailure).not.toHaveBeenCalled();
		track.dispose();
	});

	it("starts over after model progress", () => {
		const { track, onFailure } = tracker();
		for (let i = 0; i < 2; i++) { track.noteStderrLine(exhausted); track.noteStderrLine(retry("4s")); }
		track.noteProgress();
		vi.advanceTimersByTime(20_000);
		for (let i = 0; i < 2; i++) { track.noteStderrLine(exhausted); track.noteStderrLine(retry("4s")); }
		expect(onFailure).not.toHaveBeenCalled();
		track.dispose();
		vi.advanceTimersByTime(20_000);
		expect(onFailure).not.toHaveBeenCalled();
	});

	it("fails when agy goes quiet past the announced delay plus the start-up margin", () => {
		const { track, onFailure } = tracker();
		track.noteStderrLine(exhausted); track.noteStderrLine(retry("4s"));
		vi.advanceTimersByTime(4_000 + MODEL_RETRY_STARTUP_MARGIN_MS - 1);
		expect(onFailure).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(onFailure).toHaveBeenCalledExactlyOnceWith({
			code: "quota",
			message: expect.stringContaining("agy retried 1 time, next retry in 4s"),
		});
		track.dispose();
	});

	it("re-arms the quiet timer on each retry", () => {
		const { track, onFailure } = tracker();
		track.noteStderrLine(exhausted); track.noteStderrLine(retry("4s"));
		vi.advanceTimersByTime(4_000);
		track.noteStderrLine(exhausted); track.noteStderrLine(retry("7.26s"));
		vi.advanceTimersByTime(7_260 + MODEL_RETRY_STARTUP_MARGIN_MS - 1);
		expect(onFailure).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(onFailure).toHaveBeenCalledExactlyOnceWith({
			code: "quota",
			message: expect.stringContaining("agy retried 2 times, next retry in 7.26s"),
		});
		track.dispose();
	});

	it("never fires during the announced delay of a call that then recovers", () => {
		const { track, onFailure } = tracker();
		track.noteStderrLine(exhausted); track.noteStderrLine(retry("15s"));
		vi.advanceTimersByTime(15_000 + MODEL_RETRY_STARTUP_MARGIN_MS - 1);
		track.noteProgress();
		vi.advanceTimersByTime(10 * 60_000);
		expect(onFailure).not.toHaveBeenCalled();
		track.dispose();
	});

	it("stops the quiet timer on dispose", () => {
		const { track, onFailure } = tracker();
		track.noteStderrLine(exhausted); track.noteStderrLine(retry("4s"));
		track.dispose();
		vi.advanceTimersByTime(10 * 60_000);
		expect(onFailure).not.toHaveBeenCalled();
	});

	it("parses Go durations with nanosecond precision", () => {
		const { track, onFailure } = tracker();
		track.noteStderrLine(exhausted); track.noteStderrLine(retry("4.000000001s"));
		track.noteStderrLine(exhausted); track.noteStderrLine(retry("7.262817364s"));
		expect(onFailure).not.toHaveBeenCalled();
		track.noteStderrLine(exhausted); track.noteStderrLine(retry("1.5h0m0.123456789s"));
		expect(onFailure).toHaveBeenCalledExactlyOnceWith({
			code: "quota",
			message: expect.stringContaining("agy retried 3 times, next retry in 5400.12s"),
		});
		track.dispose();
	});

	it("counts a retry whose delay cannot be parsed and assumes the default delay", () => {
		const { track, onFailure } = tracker();
		track.noteStderrLine(exhausted); track.noteStderrLine(retry("a moment"));
		vi.advanceTimersByTime(MODEL_RETRY_UNPARSED_DELAY_MS + MODEL_RETRY_STARTUP_MARGIN_MS - 1);
		expect(onFailure).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(onFailure).toHaveBeenCalledExactlyOnceWith({
			code: "quota",
			message: expect.stringContaining("agy retried 1 time, next retry delay unknown, without a reply"),
		});
		track.dispose();
	});

	it("counts assumed delays toward the 15 s budget", () => {
		const { track, onFailure } = tracker();
		track.noteStderrLine(exhausted); track.noteStderrLine(retry(""));
		expect(onFailure).not.toHaveBeenCalled();
		track.noteStderrLine(exhausted); track.noteStderrLine(retry(""));
		expect(onFailure).toHaveBeenCalledExactlyOnceWith({
			code: "quota",
			message: expect.stringContaining("agy retried 2 times, next retry delay unknown"),
		});
		track.dispose();
	});

	it("counts a stderr echo of a prompt that quotes both the 429 and the retry lines", () => {
		const { track, onFailure } = tracker();
		for (let i = 0; i < 3; i++) track.noteStderrLine(`I1114 22:07:04.000003 48213 local_connection.py:553] prompt: ${exhausted} ${retry("4s")}`);
		expect(onFailure).toHaveBeenCalledOnce();
		track.dispose();
	});

	it("ignores non-retryable 4xx API errors, bare markers, prompt text and model names", () => {
		const { track, onFailure } = tracker();
		for (const status of [400, 401, 403, 404, 422]) {
			track.noteStderrLine(transientLine(status));
			track.noteStderrLine(retry("4s"));
		}
		for (let i = 0; i < 5; i++) {
			track.noteStderrLine("prompt: please explain 429 RESOURCE_EXHAUSTED");
			track.noteStderrLine(exhausted);
			track.noteStderrLine("I1114 22:07:04.000002 48213 local_connection.py:553] model gemini-4-hydrogen ready");
		}
		vi.advanceTimersByTime(400_000);
		expect(onFailure).not.toHaveBeenCalled();
		track.dispose();
	});

	it.each([408, 500, 502, 503, 504, 524])("tolerates one HTTP %i retry and fails immediately on the second with upstream cause", (status) => {
		const { track, onFailure } = tracker();
		track.noteStderrLine(transientLine(status)); track.noteStderrLine(retry("4s"));
		expect(onFailure).not.toHaveBeenCalled();
		track.noteStderrLine(transientLine(status)); track.noteStderrLine(retry("5.22s"));
		expect(onFailure).toHaveBeenCalledExactlyOnceWith({
			code: "model",
			message: `Antigravity model service temporarily unavailable (HTTP ${status}): Bad Gateway: Failed to connect to backend API; agy retried 2 times, next retry in 5.22s, without a reply.`,
		});
		track.dispose();
	});

	it("captures proxy_server.py transport timeout cause and System step error 5xx lines", () => {
		const { track, onFailure } = tracker();
		track.noteStderrLine("W1122 21:28:15.000100 48213 proxy_server.py:222] Proxy failed to connect to CCPA API: Socket operation failed to CCPA API: The read operation timed out");
		track.noteStderrLine(`${transientLine(502)}, Status: 502 Bad Gateway, Details: []`);
		track.noteStderrLine(`${retry("4s")}. Error (The model is currently unreachable.): ${transientLine(502)}, Status: 502 Bad Gateway, Details: []`);
		expect(onFailure).not.toHaveBeenCalled();

		track.noteStderrLine("WARNING: System step error (HTTP 502): The model is currently unreachable.");
		track.noteStderrLine(retry("5.77s"));
		expect(onFailure).toHaveBeenCalledExactlyOnceWith({
			code: "model",
			message: "Antigravity model service temporarily unavailable (HTTP 502): The model is currently unreachable.; agy retried 2 times, next retry in 5.77s, without a reply.",
		});
		track.dispose();
	});

	it("preserves proxy_server.py cause when the first 502 retry exhausts its 330s slow-read window", () => {
		const { track, onFailure } = tracker();
		track.noteStderrLine("W1122 21:28:15.000100 48213 proxy_server.py:222] Proxy failed to connect to CCPA API: Socket operation failed to CCPA API: The read operation timed out");
		track.noteStderrLine(`${transientLine(502)}, Status: 502 Bad Gateway, Details: []`);
		track.noteStderrLine(`${retry("4s")}. Error (The model is currently unreachable.): ${transientLine(502)}, Status: 502 Bad Gateway, Details: []`);
		vi.advanceTimersByTime(4_000 + 330_000 - 1);
		expect(onFailure).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(onFailure).toHaveBeenCalledExactlyOnceWith({
			code: "model",
			message: "Antigravity model service temporarily unavailable (HTTP 502): Bad Gateway: Failed to connect to backend API; Proxy failed to connect to CCPA API: Socket operation failed to CCPA API: The read operation timed out; agy retried 1 time, next retry in 4s, without a reply.",
		});
		track.dispose();
	});

	it("reports newer diagnostics written after the accepted retry log and keeps the tail of long proxy lines", () => {
		const { track, onFailure } = tracker();
		track.noteStderrLine(`${transientLine(502)}, Status: 502 Bad Gateway, Details: []`);
		track.noteStderrLine(retry("4s"));
		vi.advanceTimersByTime(300_000);
		track.noteStderrLine(
			`W1122 21:33:15.000100 48213 proxy_server.py:222] Proxy failed to connect to CCPA API: ${"upstream-hop-context ".repeat(20)}: Socket operation failed to CCPA API: TLS handshake timed out`,
		);
		track.noteStderrLine("I1122 21:33:15.000200 48213 local_connection.py:553] Error 504, Message: Gateway Timeout: backend deadline exceeded, Status: 504 Gateway Timeout, Details: []");
		vi.advanceTimersByTime(34_000);
		expect(onFailure).toHaveBeenCalledOnce();
		const failure = onFailure.mock.calls[0]![0]!;
		expect(failure.code).toBe("model");
		expect(failure.message).toContain("HTTP 504");
		expect(failure.message).toContain("Gateway Timeout: backend deadline exceeded");
		expect(failure.message).toContain("Socket operation failed to CCPA API: TLS handshake timed out");
		expect(failure.message).toContain("agy retried 1 time, next retry in 4s, without a reply.");
		track.dispose();
	});

	it("resets transient retry state once model progress arrives", () => {
		const { track, onFailure } = tracker();
		track.noteStderrLine(transientLine(502)); track.noteStderrLine(retry("4s"));
		track.noteProgress();
		vi.advanceTimersByTime(400_000);
		track.noteStderrLine(transientLine(502)); track.noteStderrLine(retry("4s"));
		expect(onFailure).not.toHaveBeenCalled();
		track.dispose();
	});

	it("shares the retry budget across mixed 429 and 502 retries and reports the last failure kind", () => {
		const { track, onFailure } = tracker();
		track.noteStderrLine(exhausted); track.noteStderrLine(retry("4s"));
		track.noteStderrLine(transientLine(502)); track.noteStderrLine(retry("5s"));
		expect(onFailure).toHaveBeenCalledExactlyOnceWith({
			code: "model",
			message: "Antigravity model service temporarily unavailable (HTTP 502): Bad Gateway: Failed to connect to backend API; agy retried 2 times, next retry in 5s, without a reply.",
		});
		track.dispose();
	});

	it("includes bounded redacted latest 429 and proxy diagnostics when a quota retry window expires", () => {
		vi.useFakeTimers();
		const onFailure = vi.fn();
		const watch = new PromptWatchdog(30_000, 3_600_000, onFailure);
		watch.arm();
		watch.noteStderrLine(exhausted);
		watch.noteStderrLine(retry("4s"));
		watch.noteStderrLine("W1122 21:29:00.000100 48213 proxy_server.py:222] Proxy failed to connect to CCPA API: Upstream rate limiter closed socket");
		watch.noteStderrLine(
			"W1122 21:29:00.000200 48213 http_client.go:211] Error 429, Message: Per-minute limit reached for access_token=ya29.secret-quota-token-123456, Status: RESOURCE_EXHAUSTED",
		);
		vi.advanceTimersByTime(29_999);
		expect(onFailure).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(onFailure).toHaveBeenCalledTimes(1);
		const failure = onFailure.mock.calls[0]![0] as { kind: string; code: string; message: string };
		expect(failure.kind).toBe("retry");
		expect(failure.code).toBe("quota");
		expect(failure.message).toMatch(/^Antigravity quota exceeded:/u);
		expect(failure.message).toContain("Per-minute limit reached for access_token=<redacted>");
		expect(failure.message).toContain("Proxy failed to connect to CCPA API: Upstream rate limiter closed socket");
		expect(failure.message).not.toContain("ya29.secret-quota-token-123456");
		expect(isRetryableAssistantError({ stopReason: "error", errorMessage: failure.message } as never)).toBe(false);
		watch.dispose();
	});

	it("scrubs non-retryable limit keywords from transient 5xx summaries so Pi outer retry remains enabled", () => {
		const { track, onFailure } = tracker();
		track.noteStderrLine("W1122 21:29:10.000100 48213 proxy_server.py:222] Proxy failed to connect to CCPA API: billing upstream unavailable");
		track.noteStderrLine("W1122 21:29:10.000200 48213 local_connection.py:553] Error 502, Message: Bad Gateway: upstream quota exceeded cache miss");
		track.noteStderrLine(retry("20s"));
		expect(onFailure).toHaveBeenCalledTimes(1);
		const failure = onFailure.mock.calls[0]![0] as { code: string; message: string };
		expect(failure.code).toBe("model");
		expect(failure.message).not.toMatch(/billing/iu);
		expect(isRetryableAssistantError({ stopReason: "error", errorMessage: failure.message } as never)).toBe(true);
		track.dispose();
	});
});
