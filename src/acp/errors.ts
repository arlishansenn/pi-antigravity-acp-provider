export type AntigravityAcpErrorCode =
	| "aborted"
	| "auth"
	| "model"
	| "protocol"
	| "quota"
	| "spawn"
	| "timeout"
	| "process_exit"
	| "invalid_input";

export class AntigravityAcpError extends Error {
	constructor(
		readonly code: AntigravityAcpErrorCode,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "AntigravityAcpError";
	}
}

export function abortError(message = "Antigravity ACP request aborted"): AntigravityAcpError {
	return new AntigravityAcpError("aborted", message);
}

export const ERROR_MESSAGE_LIMIT = 4_096;
export const ERROR_HEADER_LIMIT = 1_024;
export const ERROR_STDERR_TAIL_LIMIT = 2_048;
const TRUNCATION_MARKER = " ... ";

export function errorMessage(cause: unknown): string {
	const raw = cause instanceof Error && cause.message ? cause.message : String(cause);
	return redactBounded(raw, ERROR_MESSAGE_LIMIT, ERROR_HEADER_LIMIT);
}

function scrubSecrets(text: string): string {
	return text
		.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/giu, "$1<redacted>@")
		.replace(/(?:AIza|sk-|npm_|gh[opurs]_)[A-Za-z0-9_-]{12,}/gu, "<redacted>")
		.replace(/\b(?:ya29\.|1\/\/)[A-Za-z0-9._~+/-]{12,}/gu, "<redacted>")
		.replace(/((?:authorization|cookie|set-cookie)\s*[:=]\s*(?:(?:bearer|basic)\s+)?)[^\s,;]+/giu, "$1<redacted>")
		.replace(
			/((?:["']?(?:access_token|refresh_token|id_token|client_secret|api[-_]?key)["']?)\s*[:=]\s*["']?)[^"'\s,;&}]+/giu,
			"$1<redacted>",
		);
}

export function redact(text: string): string {
	return scrubSecrets(text).slice(0, ERROR_MESSAGE_LIMIT);
}

export function redactTail(text: string, limit = ERROR_MESSAGE_LIMIT): string {
	if (limit <= 0) return "";
	return scrubSecrets(text).slice(-limit);
}

export function redactBounded(
	text: string,
	limit = ERROR_MESSAGE_LIMIT,
	headLimit = ERROR_HEADER_LIMIT,
): string {
	if (limit <= 0) return "";
	const clean = scrubSecrets(text);
	if (clean.length <= limit) return clean;
	const head = Math.max(0, Math.min(headLimit, Math.floor(limit / 2)));
	const tail = limit - head - TRUNCATION_MARKER.length;
	if (head === 0 || tail <= 0) return clean.slice(-limit);
	return `${clean.slice(0, head)}${TRUNCATION_MARKER}${clean.slice(-tail)}`;
}
