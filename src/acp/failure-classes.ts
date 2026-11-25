export type FailureLayer = "google-backend" | "agy-proxy" | "oauth" | "network" | "provider" | "user";

export interface FailureClass {
	readonly id: string;
	readonly layer: FailureLayer;
	readonly pattern: RegExp;
	/** Whether Pi's isRetryableAssistantError should accept the final message. */
	readonly piRetryable: boolean;
	readonly hint?: string;
}

/** First match wins: specific causes precede the generic transport and status shapes. */
export const FAILURE_CLASSES: readonly FailureClass[] = [
	{ id: "login-required", layer: "oauth", piRetryable: false,
		pattern: /accounts\.google\.com\/o\/oauth2\/(?:v2\/)?auth\?|Antigravity sign-in required/u,
		hint: "Run /login and choose Google Antigravity (ACP), then send the message again." },
	{ id: "quota-exhausted", layer: "google-backend", piRetryable: false,
		pattern: /RESOURCE_EXHAUSTED|Antigravity quota exceeded/u },
	{ id: "capacity-exhausted", layer: "google-backend", piRetryable: true,
		pattern: /MODEL_CAPACITY_EXHAUSTED|No capacity available for model/u,
		hint: "This model tier is out of capacity; if retries keep failing, pick another tier or model with /model." },
	{ id: "ccpa-read-timeout", layer: "google-backend", piRetryable: true,
		pattern: /Socket operation failed to CCPA API: The read operation timed out/u },
	{ id: "ccpa-connection-reset", layer: "network", piRetryable: true,
		pattern: /Socket operation failed to CCPA API: \[Errno \d+\] Connection reset/u },
	{ id: "ccpa-remote-closed", layer: "network", piRetryable: true,
		pattern: /Socket operation failed to CCPA API: Remote end closed/u },
	{ id: "ccpa-tls-eof", layer: "network", piRetryable: true,
		pattern: /failed to CCPA API: EOF occurred in violation of protocol/u },
	{ id: "oauth-unreachable", layer: "oauth", piRetryable: true,
		pattern: /HTTPSConnectionPool\(host='oauth2\.googleapis\.com'/u },
	{ id: "user-aborted", layer: "user", piRetryable: false,
		pattern: /^(?:Operation aborted|Aborted after \d+ retry attempts?)$/u },
];

export function classifyFailure(text: string): FailureClass | undefined {
	return FAILURE_CLASSES.find((failure) => failure.pattern.test(text));
}
