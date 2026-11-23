import type { SessionNotification } from "@agentclientprotocol/sdk/unstable";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PromptWatchdog, type PromptWatchdogFailure } from "../src/acp/prompt-watchdog.js";

afterEach(() => vi.useRealTimers());
function watchdog() {
	vi.useFakeTimers();
	const timeout = vi.fn();
	const watch = new PromptWatchdog(100, 1000, timeout);
	watch.arm();
	return { watch, timeout };
}
const update: SessionNotification = { sessionId: "s", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "progress" } } };
const tool = (status: "in_progress" | "completed" | "failed"): SessionNotification => ({ sessionId: "s", update: { sessionUpdate: "tool_call_update", toolCallId: "t", status } });

describe("bounded prompt progress watchdog", () => {
	it("allows streaming beyond the former absolute deadline", () => {
		const { watch, timeout } = watchdog();
		for (let i = 0; i < 30; i++) { vi.advanceTimersByTime(90); watch.noteUpdate(update); }
		expect(timeout).not.toHaveBeenCalled();
		vi.advanceTimersByTime(100);
		expect(timeout).toHaveBeenCalledExactlyOnceWith({ kind: "timeout", busy: false, timeoutMs: 100 });
		watch.dispose();
	});

	it.each(["hold", "beginPermission"] as const)("gives %s a longer finite inactivity budget", (kind) => {
		const { watch, timeout } = watchdog();
		const release = watch[kind]();
		vi.advanceTimersByTime(999);
		expect(timeout).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(timeout).toHaveBeenCalledExactlyOnceWith({ kind: "timeout", busy: true, timeoutMs: 1000 });
		release(); watch.noteUpdate(update); vi.advanceTimersByTime(5000);
		expect(timeout).toHaveBeenCalledTimes(1);
		watch.dispose();
	});

	it.each(["completed", "failed"] as const)("tracks update-first native tools until %s", (status) => {
		const { watch, timeout } = watchdog();
		watch.noteUpdate(tool("in_progress"));
		vi.advanceTimersByTime(500);
		expect(timeout).not.toHaveBeenCalled();
		watch.noteUpdate(tool(status));
		vi.advanceTimersByTime(100);
		expect(timeout).toHaveBeenCalledExactlyOnceWith({ kind: "timeout", busy: false, timeoutMs: 100 });
		watch.dispose();
	});

	it("times out a native tool that never reports completion", () => {
		const { watch, timeout } = watchdog();
		watch.noteUpdate(tool("in_progress"));
		vi.advanceTimersByTime(1000);
		expect(timeout).toHaveBeenCalledExactlyOnceWith({ kind: "timeout", busy: true, timeoutMs: 1000 });
		watch.dispose();
	});

	it("keeps nested holds independent and releases idempotent", () => {
		const { watch, timeout } = watchdog();
		const a = watch.hold(), b = watch.hold();
		a(); a(); vi.advanceTimersByTime(500);
		expect(timeout).not.toHaveBeenCalled();
		b(); vi.advanceTimersByTime(100);
		expect(timeout).toHaveBeenCalledExactlyOnceWith({ kind: "timeout", busy: false, timeoutMs: 100 });
		watch.dispose();
	});

	it("disposes all state and ignores releases or updates from an old prompt", () => {
		const { watch, timeout } = watchdog();
		const release = watch.hold(); watch.noteUpdate(tool("in_progress")); watch.dispose();
		release(); watch.noteUpdate(update); watch.arm(); vi.advanceTimersByTime(5000);
		expect(timeout).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("keeps diagnosticParts readable inside onFailure before final cleanup", () => {
		vi.useFakeTimers();
		let captured: readonly string[] = [];
		const watch = new PromptWatchdog(100, 1000, () => {
			captured = watch.diagnosticParts;
		});
		watch.arm();
		watch.noteStderrLine("W1122 21:28:15.000100 48213 proxy_server.py:222] Proxy failed to connect to CCPA API: The read operation timed out");
		vi.advanceTimersByTime(100);
		expect(captured).toEqual(["Proxy failed to connect to CCPA API: The read operation timed out"]);
		expect(watch.diagnosticParts).toEqual([]);
	});

	it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])("rejects invalid timeout %s", (ms) => {
		expect(() => new PromptWatchdog(ms, 1000, () => undefined)).toThrow(RangeError);
		expect(() => new PromptWatchdog(100, ms, () => undefined)).toThrow(RangeError);
	});

	it.each([
		["default-idle", 600_000, 3_600_000],
		["short-quota-idle", 30_000, 3_600_000],
	] as const)("exhaustively verifies single-timer, ceiling, busy-immunity, and oracle equivalence (%s)", (_regime, idleMs, workIdleMs) => {
		type Action =
			| "advanceHalf"
			| "fireTimer"
			| "stderr502Retry4s"
			| "stderr429Retry4s"
			| "stderr502Retry20s"
			| "stderr504DiagOnly"
			| "stderr429DiagOnly"
			| "chunkUpdate"
			| "toolToggle"
			| "holdAcquire"
			| "holdRelease"
			| "permToggle"
			| "dispose";

		const actions: readonly Action[] = [
			"advanceHalf",
			"fireTimer",
			"stderr502Retry4s",
			"stderr429Retry4s",
			"stderr502Retry20s",
			"stderr504DiagOnly",
			"stderr429DiagOnly",
			"chunkUpdate",
			"toolToggle",
			"holdAcquire",
			"holdRelease",
			"permToggle",
			"dispose",
		];

		interface TimerEntry {
			fn: () => void;
			armedAt: number;
			duration: number;
			due: number;
		}

		interface SpecError {
			kind: "quota" | "transient";
			status?: number | undefined;
			apiMsg?: string | undefined;
			proxyMsg?: string | undefined;
		}

		type SpecFailure =
			| { kind: "timeout"; busy: boolean; timeoutMs: number; diagSnapshot: readonly string[] }
			| { kind: "retry"; code: "quota" | "model"; mustInclude: readonly string[]; diagSnapshot: readonly string[] };

		function replay(trace: readonly Action[]): string {
			const timers = new Map<number, TimerEntry>();
			let nextTimerId = 1;
			let now = 0;
			const origSet = globalThis.setTimeout;
			const origClear = globalThis.clearTimeout;
			globalThis.setTimeout = (((fn: () => void, ms?: number) => {
				const duration = Number(ms ?? 0);
				const id = nextTimerId++;
				timers.set(id, { fn, armedAt: now, duration, due: now + duration });
				return id as unknown as ReturnType<typeof setTimeout>;
			}) as typeof setTimeout);
			globalThis.clearTimeout = (((id: ReturnType<typeof setTimeout> | undefined) => {
				if (id !== undefined) timers.delete(id as unknown as number);
			}) as typeof clearTimeout);

			try {
				const failures: PromptWatchdogFailure[] = [];
				let callbackDiags: readonly string[] | undefined;
				let watch!: PromptWatchdog;
				watch = new PromptWatchdog(idleMs, workIdleMs, (failure) => {
					callbackDiags = [...watch.diagnosticParts];
					failures.push(failure);
				});
				watch.arm();

				const holdReleases: Array<() => void> = [];
				let permRelease: (() => void) | undefined;
				let toolActive = false;

				const spec = {
					disposed: false,
					failure: null as SpecFailure | null,
					holds: 0,
					perm: false,
					tool: false,
					activeRetry: false,
					retries: 0,
					waitedMs: 0,
					lastDelaySec: "",
					lastAccepted: null as SpecError | null,
					pending: null as SpecError | null,
					pendingProxy: undefined as string | undefined,
					diagProxy: undefined as string | undefined,
					diagApi: undefined as string | undefined,
					timerDuration: idleMs as number | null,
					timerDue: idleMs as number | null,
				};

				const specBusy = () => spec.holds > 0 || spec.perm || spec.tool;
				const specDiags = () => [spec.diagProxy, spec.diagApi].filter((part): part is string => Boolean(part));
				const specResetRetry = () => {
					spec.activeRetry = false;
					spec.retries = 0;
					spec.waitedMs = 0;
					spec.lastDelaySec = "";
					spec.lastAccepted = null;
					spec.pending = null;
					spec.pendingProxy = undefined;
					spec.diagProxy = undefined;
					spec.diagApi = undefined;
				};
				const specScheduleStandard = () => {
					spec.activeRetry = false;
					const duration = specBusy() ? workIdleMs : idleMs;
					spec.timerDuration = duration;
					spec.timerDue = now + duration;
				};
				const specBuildRetryFailure = (): SpecFailure => {
					let eff: SpecError | null = spec.lastAccepted;
					if (spec.pending) {
						const sameKind = spec.lastAccepted?.kind === spec.pending.kind ? spec.lastAccepted : null;
						const apiMsg = spec.pending.apiMsg ?? sameKind?.apiMsg;
						const proxyMsg = spec.pending.proxyMsg ?? spec.pendingProxy ?? sameKind?.proxyMsg;
						eff = {
							...spec.pending,
							...(apiMsg ? { apiMsg } : {}),
							...(proxyMsg ? { proxyMsg } : {}),
						};
					} else if (spec.lastAccepted && spec.pendingProxy) {
						eff = { ...spec.lastAccepted, proxyMsg: spec.pendingProxy };
					}
					const code = eff?.kind === "transient" ? "model" : "quota";
					const times = spec.retries === 1 ? "time" : "times";
					const mustInclude = [
						`agy retried ${spec.retries} ${times}, next retry in ${spec.lastDelaySec}s, without a reply.`,
						...(code === "model" && eff?.status ? [`Antigravity model service temporarily unavailable (HTTP ${eff.status})`] : []),
						...(code === "quota" ? ["Antigravity quota exceeded: the model path refused requests with HTTP 429 RESOURCE_EXHAUSTED"] : []),
						...(eff?.apiMsg ? [eff.apiMsg] : []),
						...(eff?.proxyMsg ? [eff.proxyMsg] : []),
					];
					return { kind: "retry", code, mustInclude, diagSnapshot: specDiags() };
				};
				const specNoteRetryStep = (err: SpecError, delayMs: number, delaySec: string, apiDiag: string) => {
					spec.diagApi = apiDiag;
					if (specBusy()) return;
					const current: SpecError = {
						...err,
						proxyMsg: err.proxyMsg ?? spec.pendingProxy,
					};
					spec.pendingProxy = undefined;
					spec.lastAccepted = current;
					spec.pending = null;
					spec.retries += 1;
					spec.lastDelaySec = delaySec;
					spec.waitedMs += delayMs;
					const maxRetries = current.kind === "quota" ? 2 : 1;
					const marginMs = current.kind === "quota" ? 30_000 : 330_000;
					if (spec.retries > maxRetries || spec.waitedMs > 15_000) {
						spec.failure = specBuildRetryFailure();
						spec.activeRetry = false;
						spec.timerDuration = null;
						spec.timerDue = null;
						return;
					}
					spec.activeRetry = true;
					const duration = Math.min(idleMs, delayMs + marginMs);
					spec.timerDuration = duration;
					spec.timerDue = now + duration;
				};

				const assertOracle = (stepLabel: string) => {
					const label = `[${trace.join(" -> ")}] (${stepLabel})`;
					if (spec.disposed) {
						if (failures.length !== 0) {
							throw new Error(`${label}: disposed watchdog invoked onFailure (${failures.length})`);
						}
						if (timers.size !== 0) {
							throw new Error(`${label}: disposed watchdog leaked ${timers.size} timer(s)`);
						}
						if (watch.diagnosticParts.length !== 0) {
							throw new Error(`${label}: disposed watchdog retained diagnostics`);
						}
						return;
					}
					if (spec.failure !== null) {
						if (failures.length !== 1) {
							throw new Error(`${label}: expected 1 failure, got ${failures.length}`);
						}
						if (timers.size !== 0) {
							throw new Error(`${label}: failed watchdog leaked ${timers.size} timer(s)`);
						}
						if (watch.diagnosticParts.length !== 0) {
							throw new Error(`${label}: post-settle diagnosticParts not cleared`);
						}
						expect(callbackDiags, label).toEqual(spec.failure.diagSnapshot);
						const actual = failures[0]!;
						if (spec.failure.kind === "timeout") {
							expect(actual, label).toEqual({
								kind: "timeout",
								busy: spec.failure.busy,
								timeoutMs: spec.failure.timeoutMs,
							});
						} else {
							if (actual.kind !== "retry" || actual.code !== spec.failure.code) {
								throw new Error(`${label}: expected retry/${spec.failure.code}, got ${JSON.stringify(actual)}`);
							}
							for (const expectedPart of spec.failure.mustInclude) {
								if (!actual.message.includes(expectedPart)) {
									throw new Error(`${label}: retry message "${actual.message}" missing "${expectedPart}"`);
								}
							}
						}
						return;
					}
					if (failures.length !== 0) {
						throw new Error(`${label}: live watchdog unexpectedly failed with ${JSON.stringify(failures[0])}`);
					}
					if (timers.size !== 1) {
						throw new Error(`${label}: expected exactly 1 active timer, got ${timers.size}`);
					}
					const activeTimer = [...timers.values()][0]!;
					if (activeTimer.duration !== spec.timerDuration || activeTimer.due !== spec.timerDue) {
						throw new Error(
							`${label}: expected timer (duration=${spec.timerDuration}, due=${spec.timerDue}), got (duration=${activeTimer.duration}, due=${activeTimer.due})`,
						);
					}
					if (specBusy() && activeTimer.duration !== workIdleMs) {
						throw new Error(`${label}: busy state scheduled ${activeTimer.duration}ms instead of ${workIdleMs}ms`);
					}
					if (!specBusy() && activeTimer.duration > idleMs) {
						throw new Error(`${label}: idle/retry timer ${activeTimer.duration}ms exceeded idleMs ceiling ${idleMs}ms`);
					}
					expect(watch.diagnosticParts, label).toEqual(specDiags());
				};

				assertOracle("init");

				for (const action of trace) {
					const settled = spec.disposed || spec.failure !== null;

					switch (action) {
						case "advanceHalf": {
							const entry = [...timers.values()][0];
							if (entry && entry.due > now + 1) {
								now += Math.floor((entry.due - now) / 2);
							}
							break;
						}
						case "fireTimer": {
							const entry = [...timers.entries()][0];
							if (entry) {
								timers.delete(entry[0]);
								now = entry[1].due;
								if (!settled) {
									spec.failure = spec.activeRetry
										? specBuildRetryFailure()
										: { kind: "timeout", busy: specBusy(), timeoutMs: entry[1].duration, diagSnapshot: specDiags() };
									spec.activeRetry = false;
									spec.timerDuration = null;
									spec.timerDue = null;
								}
								entry[1].fn();
							}
							break;
						}
						case "stderr502Retry4s": {
							watch.noteStderrLine("I1122 21:28:15.000200 48213 local_connection.py:553] Error 502, Message: Bad Gateway: Failed to connect to backend API");
							watch.noteStderrLine("I1122 21:28:15.000300 48213 planner_generator.go:359] Encountered retryable api error. retrying in 4s");
							if (!settled) {
								specNoteRetryStep(
									{ kind: "transient", status: 502, apiMsg: "Bad Gateway: Failed to connect to backend API" },
									4_000,
									"4",
									"Error 502, Message: Bad Gateway: Failed to connect to backend API",
								);
							}
							break;
						}
						case "stderr429Retry4s": {
							watch.noteStderrLine("W1114 22:07:04.512301 48213 http_client.go:211] Error 429, Message: Per-minute rate limit, Status: RESOURCE_EXHAUSTED");
							watch.noteStderrLine("I1114 22:07:04.512398 48213 planner_generator.go:359] Encountered retryable api error. retrying in 4s");
							if (!settled) {
								specNoteRetryStep(
									{ kind: "quota", apiMsg: "Per-minute rate limit" },
									4_000,
									"4",
									"Error 429, Message: Per-minute rate limit",
								);
							}
							break;
						}
						case "stderr502Retry20s": {
							watch.noteStderrLine("I1122 21:28:15.000200 48213 local_connection.py:553] Error 502, Message: Bad Gateway: Failed to connect to backend API");
							watch.noteStderrLine("I1122 21:28:15.000300 48213 planner_generator.go:359] Encountered retryable api error. retrying in 20s");
							if (!settled) {
								specNoteRetryStep(
									{ kind: "transient", status: 502, apiMsg: "Bad Gateway: Failed to connect to backend API" },
									20_000,
									"20",
									"Error 502, Message: Bad Gateway: Failed to connect to backend API",
								);
							}
							break;
						}
						case "stderr504DiagOnly": {
							const proxyMsg = "Proxy failed to connect to CCPA API: TLS handshake timed out";
							watch.noteStderrLine(`W1122 21:33:15.000100 48213 proxy_server.py:222] ${proxyMsg}`);
							watch.noteStderrLine("I1122 21:33:15.000200 48213 local_connection.py:553] Error 504, Message: Gateway Timeout");
							if (!settled) {
								spec.diagProxy = proxyMsg;
								spec.diagApi = "Error 504, Message: Gateway Timeout";
								if (!specBusy()) {
									spec.pending = { kind: "transient", status: 504, apiMsg: "Gateway Timeout", proxyMsg };
									spec.pendingProxy = undefined;
								}
							}
							break;
						}
						case "stderr429DiagOnly": {
							const proxyMsg = "Proxy failed to connect to CCPA API: Upstream throttle drop";
							watch.noteStderrLine(`W1122 21:33:20.000100 48213 proxy_server.py:222] ${proxyMsg}`);
							watch.noteStderrLine("W1122 21:33:20.000200 48213 http_client.go:211] Error 429, Message: Daily quota exhausted, Status: RESOURCE_EXHAUSTED");
							if (!settled) {
								spec.diagProxy = proxyMsg;
								spec.diagApi = "Error 429, Message: Daily quota exhausted";
								if (!specBusy()) {
									spec.pending = { kind: "quota", apiMsg: "Daily quota exhausted", proxyMsg };
									spec.pendingProxy = undefined;
								}
							}
							break;
						}
						case "chunkUpdate": {
							watch.noteUpdate(update);
							if (!settled) {
								specResetRetry();
								specScheduleStandard();
							}
							break;
						}
						case "toolToggle": {
							toolActive = !toolActive;
							watch.noteUpdate(tool(toolActive ? "in_progress" : "completed"));
							if (!settled) {
								spec.tool = toolActive;
								specResetRetry();
								specScheduleStandard();
							}
							break;
						}
						case "holdAcquire": {
							if (holdReleases.length < 2) {
								holdReleases.push(watch.hold());
								if (!settled) {
									spec.holds += 1;
									specResetRetry();
									specScheduleStandard();
								}
							}
							break;
						}
						case "holdRelease": {
							const rel = holdReleases.pop();
							if (rel) {
								rel();
								if (!settled) {
									spec.holds -= 1;
									specScheduleStandard();
								}
							}
							break;
						}
						case "permToggle": {
							if (!permRelease) {
								permRelease = watch.beginPermission();
								if (!settled) {
									spec.perm = true;
									specResetRetry();
									specScheduleStandard();
								}
							} else {
								const rel = permRelease;
								permRelease = undefined;
								rel();
								if (!settled) {
									spec.perm = false;
									specScheduleStandard();
								}
							}
							break;
						}
						case "dispose": {
							watch.dispose();
							if (!settled) {
								spec.disposed = true;
								spec.activeRetry = false;
								spec.holds = 0;
								spec.perm = false;
								spec.tool = false;
								specResetRetry();
								spec.timerDuration = null;
								spec.timerDue = null;
							}
							break;
						}
					}

					assertOracle(action);
				}

				if (spec.disposed) return "TERMINAL:disposed";
				if (spec.failure !== null) return `TERMINAL:failed:${spec.failure.kind}`;
				return JSON.stringify({
					holds: spec.holds,
					perm: spec.perm,
					tool: spec.tool,
					activeRetry: spec.activeRetry,
					retries: spec.retries,
					waitedMs: spec.waitedMs,
					lastDelaySec: spec.lastDelaySec,
					lastAccepted: spec.lastAccepted,
					pending: spec.pending,
					pendingProxy: spec.pendingProxy ?? null,
					diagProxy: spec.diagProxy ?? null,
					diagApi: spec.diagApi ?? null,
					timerDuration: spec.timerDuration,
					elapsed: spec.timerDue !== null && spec.timerDue - now < spec.timerDuration!,
				});
			} finally {
				globalThis.setTimeout = origSet;
				globalThis.clearTimeout = origClear;
			}
		}

		const visited = new Set<string>([replay([])]);
		const queue: Action[][] = [[]];
		let transitionsChecked = 0;

		while (queue.length > 0) {
			const prefix = queue.shift()!;
			if (prefix.length >= 6) continue;
			for (const action of actions) {
				const candidate = [...prefix, action];
				transitionsChecked += 1;
				const signature = replay(candidate);
				if (!visited.has(signature)) {
					visited.add(signature);
					queue.push(candidate);
				}
			}
		}

		expect(visited.size).toBeGreaterThan(150);
		expect(transitionsChecked).toBeGreaterThan(2_000);
	});
});
