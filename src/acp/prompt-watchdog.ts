import type { SessionNotification } from "@agentclientprotocol/sdk/unstable";

import { ModelRetryState } from "./quota.js";

export type PromptWatchdogFailure =
	| { kind: "timeout"; busy: boolean; timeoutMs: number }
	| { kind: "retry"; code: "quota" | "model"; message: string };

/** Progress, not total turn duration, bounds a prompt. Outstanding work gets
 * a longer but still finite inactivity window; a lost tool update cannot hang forever. */
export class PromptWatchdog {
	private timer: ReturnType<typeof setTimeout> | undefined;
	private holds = 0;
	private permissions = 0;
	private readonly tools = new Set<string>();
	private readonly retry = new ModelRetryState();
	private armed = false;
	private activeRetry = false;
	private settled = false;

	constructor(
		private readonly idleMs: number,
		private readonly workIdleMs: number,
		private readonly onFailure: (failure: PromptWatchdogFailure) => void,
	) {
		for (const value of [idleMs, workIdleMs]) {
			if (!Number.isFinite(value) || value <= 0 || value > 2_147_483_647) {
				throw new RangeError("Prompt inactivity timeouts must be positive finite timer durations");
			}
		}
	}

	get diagnosticParts(): readonly string[] {
		return this.retry.diagnosticParts;
	}

	arm(): void {
		if (this.settled) return;
		this.armed = true;
		if (!this.activeRetry) this.scheduleStandard();
	}

	noteStderrLine(line: string): void {
		if (this.settled || !this.armed) return;
		if (this.isBusy()) {
			this.retry.noteDiagnosticOnly(line);
			return;
		}
		const step = this.retry.noteStderrLine(line);
		if (step.kind === "exhausted") {
			this.settle({ kind: "retry", ...step.failure });
		} else if (step.kind === "accepted") {
			this.scheduleRetry(step.windowMs);
		}
	}

	noteUpdate(notification: SessionNotification): void {
		if (this.settled) return;
		const update = notification.update;
		if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
			if (update.status === "completed" || update.status === "failed") this.tools.delete(update.toolCallId);
			else if (update.sessionUpdate === "tool_call" || update.status === "pending" || update.status === "in_progress") {
				this.tools.add(update.toolCallId);
			}
		}
		this.retry.reset();
		this.activeRetry = false;
		if (this.armed) this.scheduleStandard();
	}

	hold(): () => void {
		return this.acquire("holds");
	}

	beginPermission(): () => void {
		return this.acquire("permissions");
	}

	dispose(): void {
		this.settled = true;
		this.armed = false;
		this.activeRetry = false;
		this.clearTimer();
		this.tools.clear();
		this.holds = this.permissions = 0;
		this.retry.reset();
	}

	private isBusy(): boolean {
		return this.holds > 0 || this.permissions > 0 || this.tools.size > 0;
	}

	private acquire(kind: "holds" | "permissions"): () => void {
		if (this.settled) return () => undefined;
		this[kind] += 1;
		this.retry.reset();
		this.activeRetry = false;
		if (this.armed) this.scheduleStandard();
		let released = false;
		return () => {
			if (released || this.settled) return;
			released = true;
			this[kind] -= 1;
			if (this.armed) this.scheduleStandard();
		};
	}

	private scheduleStandard(): void {
		this.clearTimer();
		if (this.settled) return;
		this.activeRetry = false;
		const busy = this.isBusy();
		const duration = busy ? this.workIdleMs : this.idleMs;
		this.timer = setTimeout(() => {
			this.settle({ kind: "timeout", busy, timeoutMs: duration });
		}, duration);
		this.timer.unref?.();
	}

	private scheduleRetry(windowMs: number): void {
		this.clearTimer();
		if (this.settled) return;
		this.activeRetry = true;
		const duration = Math.min(this.idleMs, windowMs);
		this.timer = setTimeout(() => {
			this.settle({ kind: "retry", ...this.retry.buildFailure() });
		}, duration);
		this.timer.unref?.();
	}

	private settle(failure: PromptWatchdogFailure): void {
		if (this.settled) return;
		this.settled = true;
		this.armed = false;
		this.activeRetry = false;
		this.clearTimer();
		try {
			this.onFailure(failure);
		} finally {
			this.tools.clear();
			this.holds = this.permissions = 0;
			this.retry.reset();
		}
	}

	private clearTimer(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
	}
}
