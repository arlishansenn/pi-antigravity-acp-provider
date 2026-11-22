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

/** agy retries model-path 429 RESOURCE_EXHAUSTED and transient 408/502/503/504 errors on stderr without emitting ACP updates.
 * Tolerate this many retries per inference before failing the prompt. */
export const MODEL_RETRY_MAX_RETRIES = 2;
export const MODEL_RETRY_DELAY_BUDGET_MS = 15_000;
/** After a retry, agy logs nothing more if the call succeeds, so silence alone cannot tell recovery from a hang.
 * Each retry therefore allows its announced delay plus this margin for the model to start streaming. */
export const MODEL_RETRY_STARTUP_MARGIN_MS = 30_000;
export const MODEL_RETRY_UNPARSED_DELAY_MS = 10_000;
const API_ERROR = /\bError (\d{3}), Message: /u;
const EXHAUSTED = /\bError 429, Message: .*, Status: RESOURCE_EXHAUSTED\b/u;
const TRANSIENT_STATUSES = new Set([408, 502, 503, 504]);
// The delay is Go's time.Duration.String(), e.g. "4s", "7.262817364s", "1m2.5s"; it stays optional so a
// format change still counts the retry.
const RETRY = /\bEncountered retryable api error\. retrying in\b(?: ((?:\d+(?:\.\d+)?(?:h|ms|m|s|us|µs|ns))+))?/u;
const DURATION_MS: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1_000, ms: 1, us: 1e-3, "µs": 1e-3, ns: 1e-6 };

type PendingRetryError =
	| { kind: "quota" }
	| { kind: "transient"; status: number };

export interface RetryExhaustionFailure {
	code: "quota" | "model";
	message: string;
}

export class ModelRetryTracker {
	private pending: PendingRetryError | undefined;
	private lastError: PendingRetryError | undefined;
	private retries = 0;
	private nextDelayMs: number | undefined;
	private waitedMs = 0;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private done = false;

	constructor(private readonly onFailure: (failure: RetryExhaustionFailure) => void) {}

	noteStderrLine(line: string): void {
		if (this.done) return;
		const apiError = API_ERROR.exec(line);
		if (apiError) {
			const status = Number(apiError[1]);
			if (EXHAUSTED.test(line)) this.pending = { kind: "quota" };
			else if (TRANSIENT_STATUSES.has(status)) this.pending = { kind: "transient", status };
			else this.pending = undefined;
		}
		const retry = RETRY.exec(line);
		if (!retry || !this.pending) return;
		this.lastError = this.pending;
		this.pending = undefined;
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
		if (this.retries > MODEL_RETRY_MAX_RETRIES || this.waitedMs > MODEL_RETRY_DELAY_BUDGET_MS) {
			this.fire();
			return;
		}
		this.clearTimer();
		this.timer = setTimeout(() => this.fire(), delayMs + MODEL_RETRY_STARTUP_MARGIN_MS);
		this.timer.unref?.();
	}

	noteProgress(): void {
		if (this.done) return;
		this.pending = undefined;
		this.lastError = undefined;
		this.retries = 0;
		this.waitedMs = 0;
		this.clearTimer();
	}

	dispose(): void {
		this.done = true;
		this.clearTimer();
	}

	private fire(): void {
		const failure = this.lastError;
		this.dispose();
		const times = this.retries === 1 ? "time" : "times";
		const next = this.nextDelayMs === undefined ? "next retry delay unknown"
			: `next retry in ${Number((this.nextDelayMs / 1_000).toFixed(2))}s`;
		if (failure?.kind === "transient") {
			this.onFailure({
				code: "model",
				message:
					`Antigravity model service temporarily unavailable (HTTP ${failure.status}): ` +
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

	private clearTimer(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
	}
}
