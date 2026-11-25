#!/usr/bin/env node
// Usage: fault-proxy.mjs --port <n> --log <file> --mode pass|stall|swallow|close [--match <host-regex>] [--threshold <bytes>] [--upstream http://host:port]
import fs from "node:fs";
import http from "node:http";
import net from "node:net";

const options = { mode: "pass", match: ".", threshold: 16_384 };
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 2) options[args[index].replace(/^--/u, "")] = args[index + 1];
const port = Number(options.port);
const threshold = Number(options.threshold);
if (!Number.isInteger(port) || !options.log || !["pass", "stall", "swallow", "close"].includes(options.mode) || !Number.isInteger(threshold)) {
	console.error("usage: fault-proxy.mjs --port <n> --log <file> --mode pass|stall|swallow|close [--match <regex>] [--threshold <bytes>] [--upstream http://host:port]");
	process.exit(2);
}
const match = new RegExp(options.match, "u");
const upstream = options.upstream ? new URL(options.upstream) : undefined;
const log = (event) => fs.appendFileSync(options.log, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);

function openTunnel(host, targetPort) {
	return new Promise((resolve, reject) => {
		if (!upstream) {
			const socket = net.connect(targetPort, host, () => resolve(socket));
			socket.once("error", reject);
			return;
		}
		const request = http.request({ host: upstream.hostname, port: upstream.port, method: "CONNECT", path: `${host}:${targetPort}` });
		request.once("connect", (response, socket) => response.statusCode === 200 ? resolve(socket) : reject(new Error(`upstream CONNECT ${response.statusCode}`)));
		request.once("error", reject);
		request.end();
	});
}

let nextId = 0;
const server = http.createServer((request, response) => {
	log({ kind: "plain-http", url: request.url });
	response.writeHead(501).end("fault-proxy forwards CONNECT only");
});
server.on("connect", async (request, client, head) => {
	const id = ++nextId;
	const [host, rawPort] = request.url.split(":");
	const targeted = match.test(host) && options.mode !== "pass";
	log({ kind: "connect", id, host, port: Number(rawPort), targeted });
	let target;
	try {
		target = await openTunnel(host, Number(rawPort));
	} catch (error) {
		log({ kind: "upstream-error", id, host, error: String(error) });
		client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
		return;
	}
	client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
	if (head.length) target.write(head);
	let sent = head.length;
	let tripped = false;
	client.on("data", (chunk) => {
		sent += chunk.length;
		if (targeted && !tripped && sent > threshold) {
			tripped = true;
			log({ kind: "fault", id, host, mode: options.mode, clientBytes: sent });
			if (options.mode === "close") { target.destroy(); client.destroy(); return; }
		}
		target.write(chunk);
	});
	target.on("data", (chunk) => { if (!(tripped && (options.mode === "stall" || options.mode === "swallow"))) client.write(chunk); });
	const finish = (side) => () => {
		log({ kind: "closed", id, host, side, clientBytes: sent });
		if (side === "target" && tripped && options.mode === "stall") return;
		client.destroy();
		target.destroy();
	};
	client.once("close", finish("client"));
	target.once("close", finish("target"));
	client.on("error", () => undefined);
	target.on("error", () => undefined);
});
server.listen(port, "127.0.0.1", () => log({ kind: "listening", port, mode: options.mode, match: options.match, threshold, upstream: options.upstream ?? null }));
