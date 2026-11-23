import { describe, expect, it } from "vitest";

import { AntigravityAcpError, errorMessage, redact, redactTail } from "../src/acp/errors.js";

describe("diagnostic redaction", () => {
	it("removes proxy URL credentials and Basic authorization values", () => {
		const output = redact("HTTPS_PROXY=http://user:proxy-password@proxy.test:8080\nProxy-Authorization: Basic dXNlcjpwYXNzd29yZA==");
		expect(output).toContain("http://<redacted>@proxy.test:8080");
		expect(output).not.toContain("proxy-password");
		expect(output).not.toContain("dXNlcjpwYXNzd29yZA==");
	});
	it("removes common API key, OAuth, header, and cookie secrets", () => {
		const input = [
			"AIza1234567890abcdef",
			"refresh_token=1//abcdefghijklmnopqrstuvwxyz",
			'\"access_token\":\"ya29.abcdefghijklmnopqrstuvwxyz\"',
			"Authorization: Bearer header-secret-value",
			"Cookie: session=secret-value",
		].join("\n");
		const output = redact(input);
		expect(output).not.toContain("1234567890abcdef");
		expect(output).not.toContain("abcdefghijklmnopqrstuvwxyz");
		expect(output).not.toContain("header-secret-value");
		expect(output).not.toContain("session=secret-value");
		expect(output.match(/<redacted>/gu)?.length).toBeGreaterThanOrEqual(5);
	});
	it("preserves the latest 4 KiB while scrubbing secrets in redactTail", () => {
		const prefix = `${"startup-banner-line\n".repeat(300)}Authorization: Bearer early-secret\n`;
		const suffix = "Error 502, Message: Bad Gateway\nAuthorization: Bearer tail-secret-token";
		const input = `${prefix}${suffix}`;
		expect(input.length).toBeGreaterThan(4_096);

		const head = redact(input);
		expect(head.length).toBe(4_096);
		expect(head).not.toContain("Error 502");

		const tail = redactTail(input);
		expect(tail.length).toBe(4_096);
		expect(tail).toContain("Error 502, Message: Bad Gateway");
		expect(tail).toContain("Authorization: Bearer <redacted>");
		expect(tail).not.toContain("early-secret");
		expect(tail).not.toContain("tail-secret-token");
	});
	it("supports a custom tail limit so prefixed errorMessage output keeps the final stderr line intact", () => {
		const input = `${"startup-banner-line\n".repeat(450)}Authorization: Bearer secret-token-value\nError 502, Message: Bad Gateway: final-tail-marker`;
		const bounded = redactTail(input, 2_048);
		expect(bounded.length).toBeLessThanOrEqual(2_048);
		expect(bounded).toContain("Authorization: Bearer <redacted>");
		expect(bounded).toContain("Error 502, Message: Bad Gateway: final-tail-marker");

		const formatted = errorMessage(
			new AntigravityAcpError(
				"timeout",
				`Antigravity ACP session/prompt timed out: no progress for 600000ms: ${bounded}`,
			),
		);
		expect(formatted.length).toBeLessThanOrEqual(4_096);
		expect(formatted).toContain("Error 502, Message: Bad Gateway: final-tail-marker");
		expect(formatted).not.toContain("secret-token-value");
	});
	it("keeps both the classification prefix and the final root cause when errorMessage exceeds 4 KiB", () => {
		const raw = [
			"Antigravity ACP error -32603: Internal error:",
			"stack-frame-noise ".repeat(300),
			"Authorization: Bearer trailing-secret-token",
			"proxy_server.py:222] Proxy failed to connect to CCPA API: Remote end closed connection without response",
			"API_ERROR: HTTP 502 Bad Gateway",
		].join("\n");
		expect(raw.length).toBeGreaterThan(5_000);

		const formatted = errorMessage(new AntigravityAcpError("protocol", raw));
		expect(formatted.length).toBeLessThanOrEqual(4_096);
		expect(formatted.startsWith("Antigravity ACP error -32603: Internal error:")).toBe(true);
		expect(formatted).toContain("proxy_server.py:222] Proxy failed to connect to CCPA API: Remote end closed connection without response");
		expect(formatted).toContain("API_ERROR: HTTP 502 Bad Gateway");
		expect(formatted).toContain("Authorization: Bearer <redacted>");
		expect(formatted).not.toContain("trailing-secret-token");
	});
});
