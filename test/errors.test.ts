import { describe, expect, it } from "vitest";

import { redact, redactTail } from "../src/acp/errors.js";

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
});
