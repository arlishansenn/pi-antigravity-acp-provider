const UNIT_MS: Record<string, number> = { day: 86_400_000, hour: 3_600_000, minute: 60_000, second: 1_000 };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// agy replies with this fixed notice, without usage, when the account's quota is exhausted.
const NOTICE = new RegExp(
	"(?:^|\\n)Usage Limit Reached\\n\\nYou have reached your current quota for this period\\." +
		"(?: Your limit will reset (?:in ((?:\\d+ (?:day|hour|minute|second)s?(?:, )?)+)" +
		`|on (${MONTHS.join("|")}) (\\d{1,2}), (\\d{4}) (\\d{2}):(\\d{2}) UTC)\\.)?$`,
	"u",
);

export function quotaExhaustion(text: string, now = Date.now()): { resetAt?: string } | undefined {
	const match = NOTICE.exec(text.trim());
	if (!match) return undefined;
	const [, relative, month, day, year, hours, minutes] = match;
	if (relative) {
		let ms = 0;
		for (const [, count, unit] of relative.matchAll(/(\d+) (day|hour|minute|second)/gu)) ms += Number(count) * UNIT_MS[unit!]!;
		return { resetAt: new Date(now + ms).toISOString() };
	}
	if (month) return { resetAt: new Date(Date.UTC(Number(year), MONTHS.indexOf(month), Number(day), Number(hours), Number(minutes))).toISOString() };
	return {};
}

export const RESOURCE_EXHAUSTED_MAX_RETRIES = 2;
export const TRANSIENT_MODEL_MAX_RETRIES = 1;
export const MODEL_RETRY_DELAY_BUDGET_MS = 15_000;
/** After a retry, agy logs nothing more if the call succeeds, so silence alone cannot tell recovery from a hang. */
export const MODEL_RETRY_STARTUP_MARGIN_MS = 30_000;
/** Covers agy's internal 300 s CCPA proxy read timeout plus connection and streaming startup margin on the single 5xx retry. */
export const TRANSIENT_MODEL_RETRY_WINDOW_MS = 330_000;
export const MODEL_RETRY_UNPARSED_DELAY_MS = 10_000;

const RETRY_POLICIES = {
	quota: { maxRetries: RESOURCE_EXHAUSTED_MAX_RETRIES, windowMs: MODEL_RETRY_STARTUP_MARGIN_MS },
	transient: { maxRetries: TRANSIENT_MODEL_MAX_RETRIES, windowMs: TRANSIENT_MODEL_RETRY_WINDOW_MS },
} as const;

const PROXY_ERROR = /\bproxy_server\.py:\d+\]\s*(Proxy failed to connect to CCPA API:\s*[^\r\n]+)/u;
const SYSTEM_STEP_ERROR = /\bSystem step error \(HTTP (\d{3})\):\s*([^\r\n]+)/u;
const API_ERROR = /\bError (\d{3}), Message:\s*([^\r\n]+)/u;
const EXHAUSTED = /\bError 429, Message: .*, Status: RESOURCE_EXHAUSTED\b/u;
// The delay is Go's time.Duration.String(), e.g. "4s", "7.262817364s", "1m2.5s"; it stays optional so a
// format change still counts the retry.
const RETRY = /\bEncountered retryable api error\. retrying in\b(?: ((?:\d+(?:\.\d+)?(?:h|ms|m|s|us|µs|ns))+))?/u;
const DURATION_MS: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1_000, ms: 1, us: 1e-3, "µs": 1e-3, ns: 1e-6 };

type PendingRetryError =
	| { kind: "quota" }
	| { kind: "transient"; status: number; apiMessage?: string; proxyDetail?: string };

export interface RetryExhaustionFailure {
	code: "quota" | "model";
	message: string;
}

function isTransientModelStatus(status: number): boolean {
	return status === 408 || (status >= 500 && status <= 599);
}

function compactDiagnostic(text: string, limit = 512): string {
	const trimmed = text.trim();
	if (trimmed.length <= limit) return trimmed;
	const head = 192;
	const marker = " ... ";
	return `${trimmed.slice(0, head)}${marker}${trimmed.slice(-(limit - head - marker.length))}`;
}

function cleanApiMessage(raw: string): string {
	return compactDiagnostic(
		raw
			.replace(/,\s*Status:\s*[^\r\n]*$/u, "")
			.replace(/,\s*Details:\s*\[[^\r\n]*$/u, ""),
	);
}

function joinDiagnosticParts(primary?: string, secondary?: string): string | undefined {
	const first = primary?.trim();
	const second = secondary?.trim();
	if (first && second && !first.includes(second)) return `${first}; ${second}`;
	return first || second || undefined;
}

export class StderrDiagnosticTracker {
	private proxyDetail: string | undefined;
	private apiDetail: string | undefined;

	noteStderrLine(line: string): void {
		const proxyMatch = PROXY_ERROR.exec(line);
		if (proxyMatch) {
			this.proxyDetail = compactDiagnostic(proxyMatch[1]!);
		}
		const apiMatch = API_ERROR.exec(line);
		if (apiMatch) {
			const status = Number(apiMatch[1]);
			const message = cleanApiMessage(apiMatch[2]!);
			if (message) this.apiDetail = `Error ${status}, Message: ${message}`;
			return;
		}
		const stepMatch = SYSTEM_STEP_ERROR.exec(line);
		if (stepMatch) {
			this.apiDetail = `System step error (HTTP ${stepMatch[1]}): ${compactDiagnostic(stepMatch[2]!)}`;
		}
	}

	reset(): void {
		this.proxyDetail = undefined;
		this.apiDetail = undefined;
	}

	get parts(): readonly string[] {
		return [this.proxyDetail, this.apiDetail].filter((part): part is string => Boolean(part));
	}

	get summary(): string | undefined {
		return joinDiagnosticParts(this.proxyDetail, this.apiDetail);
	}
}

export class ModelRetryTracker {
	private pending: PendingRetryError | undefined;
	private pendingProxyDetail: string | undefined;
	private lastError: PendingRetryError | undefined;
	private readonly diagnostics = new StderrDiagnosticTracker();
	private retries = 0;
	private nextDelayMs: number | undefined;
	private waitedMs = 0;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private done = false;

	constructor(
		private readonly onFailure: (failure: RetryExhaustionFailure) => void,
		private readonly onRetry?: () => void,
	) {}

	get diagnosticParts(): readonly string[] {
		return this.diagnostics.parts;
	}

	get diagnostic(): string | undefined {
		return this.diagnostics.summary;
	}

	noteStderrLine(line: string): void {
		if (this.done) return;
		this.diagnostics.noteStderrLine(line);
		const proxyMatch = PROXY_ERROR.exec(line);
		if (proxyMatch) {
			this.pendingProxyDetail = compactDiagnostic(proxyMatch[1]!);
		}
		const apiError = API_ERROR.exec(line);
		if (apiError) {
			const status = Number(apiError[1]);
			if (EXHAUSTED.test(line)) {
				this.pending = { kind: "quota" };
				this.pendingProxyDetail = undefined;
			} else if (isTransientModelStatus(status)) {
				const apiMessage = cleanApiMessage(apiError[2]!);
				this.pending = {
					kind: "transient",
					status,
					...(apiMessage ? { apiMessage } : {}),
					...(this.pendingProxyDetail ? { proxyDetail: this.pendingProxyDetail } : {}),
				};
			} else {
				this.pending = undefined;
				this.pendingProxyDetail = undefined;
			}
		} else {
			const stepError = SYSTEM_STEP_ERROR.exec(line);
			if (stepError) {
				const status = Number(stepError[1]);
				if (isTransientModelStatus(status)) {
					const apiMessage = compactDiagnostic(stepError[2]!);
					this.pending = {
						kind: "transient",
						status,
						...(apiMessage ? { apiMessage } : {}),
						...(this.pendingProxyDetail ? { proxyDetail: this.pendingProxyDetail } : {}),
					};
				}
			}
		}
		const retry = RETRY.exec(line);
		if (!retry || !this.pending) return;
		const current = this.pending;
		this.lastError = current;
		this.pending = undefined;
		this.pendingProxyDetail = undefined;
		this.retries += 1;
		this.nextDelayMs = undefined;
		if (retry[1]) {
			this.nextDelayMs = 0;
			for (const [, count, unit] of retry[1].matchAll(/(\d+(?:\.\d+)?)(h|ms|m|s|us|µs|ns)/gu)) {
				this.nextDelayMs += Number(count) * DURATION_MS[unit!]!;
			}
		}
		const delayMs = this.nextDelayMs ?? MODEL_RETRY_UNPARSED_DELAY_MS;
		this.waitedMs += delayMs;
		const policy = RETRY_POLICIES[current.kind];
		if (this.retries > policy.maxRetries || this.waitedMs > MODEL_RETRY_DELAY_BUDGET_MS) {
			this.fire();
			return;
		}
		this.onRetry?.();
		this.clearTimer();
		this.timer = setTimeout(() => this.fire(), delayMs + policy.windowMs);
		this.timer.unref?.();
	}

	noteProgress(): void {
		if (this.done) return;
		this.pending = undefined;
		this.pendingProxyDetail = undefined;
		this.lastError = undefined;
		this.diagnostics.reset();
		this.retries = 0;
		this.waitedMs = 0;
		this.clearTimer();
	}

	dispose(): void {
		this.done = true;
		this.clearTimer();
	}

	private fire(): void {
		const failure = this.latestFailure();
		this.dispose();
		const times = this.retries === 1 ? "time" : "times";
		const next = this.nextDelayMs === undefined ? "next retry delay unknown"
			: `next retry in ${Number((this.nextDelayMs / 1_000).toFixed(2))}s`;
		if (failure?.kind === "transient") {
			const detail = joinDiagnosticParts(failure.apiMessage, failure.proxyDetail);
			const detailSuffix = detail ? `: ${detail};` : ":";
			this.onFailure({
				code: "model",
				message:
					`Antigravity model service temporarily unavailable (HTTP ${failure.status})${detailSuffix} ` +
					`agy retried ${this.retries} ${times}, ${next}, without a reply.`,
			});
			return;
		}
		// "quota exceeded" makes Pi's isRetryableAssistantError return false despite "429" and "rate limit".
		this.onFailure({
			code: "quota",
			message:
				"Antigravity quota exceeded: the model path refused requests with HTTP 429 RESOURCE_EXHAUSTED (rate limit or entitlement); " +
				`agy retried ${this.retries} ${times}, ${next}, without a reply. ` +
				"Retry later or switch to another provider.",
		});
	}

	private latestFailure(): PendingRetryError | undefined {
		if (this.pending) {
			if (this.pending.kind === "transient" && this.lastError?.kind === "transient") {
				return {
					...this.pending,
					...(this.pending.proxyDetail ?? this.lastError.proxyDetail
						? { proxyDetail: this.pending.proxyDetail ?? this.lastError.proxyDetail }
						: {}),
				};
			}
			return this.pending;
		}
		if (this.lastError?.kind === "transient" && this.pendingProxyDetail) {
			return { ...this.lastError, proxyDetail: this.pendingProxyDetail };
		}
		return this.lastError;
	}

	private clearTimer(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
	}
}
