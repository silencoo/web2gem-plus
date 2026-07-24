import http from "node:http";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { pathToFileURL } from "node:url";

const port = Number(process.env.PORT || 52389);
const host = process.env.HOST || "0.0.0.0";
const env = { ...process.env };
let defaultWorkerPromise = null;

export function requestHeaders(rawHeaders) {
	const headers = new Headers();
	for (let i = 0; i < rawHeaders.length; i += 2) {
		const name = rawHeaders[i];
		const value = rawHeaders[i + 1];
		if (name && value !== undefined) headers.append(name, value);
	}
	return headers;
}

export function requestUrl(req, fallbackPort = port) {
	const scheme =
		firstForwardedHeaderValue(req.headers["x-forwarded-proto"]) || "http";
	const forwardedHost = firstForwardedHeaderValue(
		req.headers["x-forwarded-host"],
	);
	const authority =
		forwardedHost ||
		firstForwardedHeaderValue(req.headers.host) ||
		`localhost:${fallbackPort}`;
	return `${scheme}://${authority}${req.url || "/"}`;
}

function firstForwardedHeaderValue(value) {
	const raw = Array.isArray(value) ? value[0] : value;
	return String(raw || "")
		.split(",")[0]
		.trim();
}

export function executionContext() {
	const pending = new Set();
	return {
		waitUntil(promise) {
			const p = Promise.resolve(promise).catch((err) => {
				console.error("waitUntil failed:", err);
			});
			pending.add(p);
			p.finally(() => pending.delete(p));
		},
		passThroughOnException() {},
	};
}

export async function handleDockerRequest(req, res, options = {}) {
	const workerImpl = options.worker || (await defaultWorker());
	const requestEnv = options.env || env;
	const fallbackPort = Number(options.port || port);
	const method = req.method || "GET";
	const init = {
		method,
		headers: requestHeaders(req.rawHeaders),
	};

	if (method !== "GET" && method !== "HEAD") {
		init.body = Readable.toWeb(req);
		init.duplex = "half";
	}

	const request = new Request(requestUrl(req, fallbackPort), init);
	const response = await workerImpl.fetch(
		request,
		requestEnv,
		executionContext(),
	);

	res.statusCode = response.status;
	response.headers.forEach((value, key) => {
		res.setHeader(key, value);
	});

	if (!response.body || method === "HEAD") {
		res.end();
		return;
	}

	const body = Readable.fromWeb(response.body);
	body.pipe(res);
	await finished(res);
}

async function defaultWorker() {
	if (!defaultWorkerPromise) {
		defaultWorkerPromise = import("../dist/worker.js").then(
			(mod) => mod.default || mod,
		);
	}
	return defaultWorkerPromise;
}

export function createDockerServer(options = {}) {
	return http.createServer((req, res) => {
		handleDockerRequest(req, res, options).catch((err) => {
			console.error("request failed:", err);
			if (!res.headersSent) {
				res.statusCode = 500;
				res.setHeader("content-type", "application/json; charset=utf-8");
			}
			res.end(JSON.stringify({ error: { message: "internal server error" } }));
		});
	});
}

export function startDockerServer(options = {}) {
	const server = createDockerServer(options);
	const listenPort = Number(options.port || port);
	const listenHost = options.host || host;
	server.listen(listenPort, listenHost, () => {
		console.log(`web2gem-plus listening on http://${listenHost}:${listenPort}`);
	});
	return server;
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	startDockerServer();
}
