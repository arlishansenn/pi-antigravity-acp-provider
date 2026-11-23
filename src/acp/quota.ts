import { redactBounded } from "./errors.js";

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
export const MODEL_RETRY_STARTUP_MARGIN_MS = 30_000;
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
	| { kind: "quota"; apiMessage?: string; proxyDetail?: string }
	| { kind: "transient"; status: number; apiMessage?: string; proxyDetail?: string };

export interface RetryExhaustionFailure {
	code: "quota" | "model";
	message: string;
}

export type RetryStepResult =
	| { kind: "none" }
	| { kind: "accepted"; windowMs: number }
	| { kind: "exhausted"; failure: RetryExhaustionFailure };

const GENERIC_QUOTA_MESSAGE = /^resource (?:has been )?exhausted(?:\s*\(e\.g\.\s*check quota\)\.?)?\.?$/iu;
const NON_RETRYABLE_PROVIDER_KEYWORDS =
	/GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing|subscription_sharing_usage_limit_exceeded|subscription_sharing_workplace_individual_usage_limit_exceeded|"code"\s*:\s*"?1308(?![0-9])/giu;

export function scrubNonRetryableKeywords(text: string): string {
	return text.replace(NON_RETRYABLE_PROVIDER_KEYWORDS, "<redacted>");
}

export function isGenericQuotaDiagnostic(text: string): boolean {
	const match = /^Error 429,\s*Message:\s*(.+)$/iu.exec(text.trim());
	return match ? GENERIC_QUOTA_MESSAGE.test(match[1]!.trim()) : GENERIC_QUOTA_MESSAGE.test(text.trim());
}

function isTransientModelStatus(status: number): boolean {
	return status === 408 || (status >= 500 && status <= 599);
}

function compactDiagnostic(text: string, limit = 512): string {
	return redactBounded(text.trim(), limit, 192);
}

function cleanApiMessage(raw: string): string {
	return compactDiagnostic(
		raw
			.replace(/,\s*Status:\s*[^\r\n]*$/u, "")
			.replace(/,\s*Details:\s*\[[^\r\n]*$/u, ""),
	);
}

function cleanQuotaMessage(raw: string): string | undefined {
	const cleaned = cleanApiMessage(raw);
	return cleaned && !GENERIC_QUOTA_MESSAGE.test(cleaned) ? cleaned : undefined;
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

export class ModelRetryState {
	private pending: PendingRetryError | undefined;
	private pendingProxyDetail: string | undefined;
	private lastError: PendingRetryError | undefined;
	private readonly diagnostics = new StderrDiagnosticTracker();
	private retries = 0;
	private nextDelayMs: number | undefined;
	private waitedMs = 0;

	get diagnosticParts(): readonly string[] {
		return this.diagnostics.parts;
	}

	noteDiagnosticOnly(line: string): void {
		this.diagnostics.noteStderrLine(line);
	}

	noteStderrLine(line: string): RetryStepResult {
		this.diagnostics.noteStderrLine(line);
		const proxyMatch = PROXY_ERROR.exec(line);
		if (proxyMatch) {
			this.pendingProxyDetail = compactDiagnostic(proxyMatch[1]!);
		}
		const apiError = API_ERROR.exec(line);
		if (apiError) {
			const status = Number(apiError[1]);
			if (EXHAUSTED.test(line)) {
				const apiMessage = cleanQuotaMessage(apiError[2]!);
				this.pending = {
					kind: "quota",
					...(apiMessage ? { apiMessage } : {}),
					...(this.pendingProxyDetail ? { proxyDetail: this.pendingProxyDetail } : {}),
				};
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
		if (!retry || !this.pending) return { kind: "none" };
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
			return { kind: "exhausted", failure: this.buildFailure() };
		}
		return { kind: "accepted", windowMs: delayMs + policy.windowMs };
	}

	reset(): void {
		this.pending = undefined;
		this.pendingProxyDetail = undefined;
		this.lastError = undefined;
		this.diagnostics.reset();
		this.retries = 0;
		this.nextDelayMs = undefined;
		this.waitedMs = 0;
	}

	buildFailure(): RetryExhaustionFailure {
		const failure = this.latestFailure();
		const times = this.retries === 1 ? "time" : "times";
		const next = this.nextDelayMs === undefined ? "next retry delay unknown"
			: `next retry in ${Number((this.nextDelayMs / 1_000).toFixed(2))}s`;
		if (failure?.kind === "transient") {
			const rawDetail = joinDiagnosticParts(failure.apiMessage, failure.proxyDetail);
			const detail = rawDetail ? scrubNonRetryableKeywords(rawDetail) : undefined;
			const detailSuffix = detail ? `: ${detail};` : ":";
			return {
				code: "model",
				message:
					`Antigravity model service temporarily unavailable (HTTP ${failure.status})${detailSuffix} ` +
					`agy retried ${this.retries} ${times}, ${next}, without a reply.`,
			};
		}
		const quotaDetail = joinDiagnosticParts(failure?.apiMessage, failure?.proxyDetail);
		const quotaSuffix = quotaDetail ? `: ${quotaDetail};` : ";";
		// "quota exceeded" makes Pi's isRetryableAssistantError return false despite "429" and "rate limit".
		return {
			code: "quota",
			message:
				`Antigravity quota exceeded: the model path refused requests with HTTP 429 RESOURCE_EXHAUSTED (rate limit or entitlement)${quotaSuffix} ` +
				`agy retried ${this.retries} ${times}, ${next}, without a reply. ` +
				"Retry later or switch to another provider.",
		};
	}

	private latestFailure(): PendingRetryError | undefined {
		if (this.pending) {
			const sameKind = this.lastError?.kind === this.pending.kind ? this.lastError : undefined;
			const apiMessage = this.pending.apiMessage ?? sameKind?.apiMessage;
			const proxyDetail = this.pending.proxyDetail ?? this.pendingProxyDetail ?? sameKind?.proxyDetail;
			return {
				...this.pending,
				...(apiMessage ? { apiMessage } : {}),
				...(proxyDetail ? { proxyDetail } : {}),
			};
		}
		if (this.lastError && this.pendingProxyDetail) {
			return { ...this.lastError, proxyDetail: this.pendingProxyDetail };
		}
		return this.lastError;
	}
}
