import { createRuntimeConfig, getConfig, RuntimeConfigError } from "./config";
import {
	authorized,
	corsHeaders,
	jsonResponse,
	jsonTextResponse,
	openAIErrorResponse,
	withCORS,
} from "./http";
import {
	handleChat,
	handleImageEdits,
	handleImageEditsMultipart,
	handleImageGenerations,
	handleResponses,
} from "./http/openai";
import { handleGoogleGenerate } from "./http/google/handlers";
import {
	GOOGLE_MODEL_JSON_BY_ID,
	GOOGLE_MODEL_LIST_JSON,
	HEALTH_JSON,
	NOT_FOUND_JSON,
	OPENAI_MODEL_JSON_BY_ID,
	OPENAI_MODEL_LIST_JSON,
} from "./http/core/model-routes";
import { googleJsonError, readRouteJsonPost } from "./http/core/route-json";
import { createGeminiCompletionProvider } from "./gemini/completion-provider";
import { elapsedMs, log, logStage, nowMs } from "./shared/logging";
import { errorLogSummary } from "./shared/errors";
import { uuid } from "./shared/crypto";
import type { RuntimeConfig, WorkerEnv } from "./config";
import type { RouteJsonPostResult } from "./http/core/route-json";
import {
	configWithPooledGeminiSession,
	NoAvailableGeminiSessionError,
} from "./gemini/session-pool";
import { handleAdminRequest } from "./admin";

const GOOGLE_GENERATE_PATH_RE =
	/^\/v(?:1beta|1)\/models\/[^/?#]+:generateContent$/;
const GOOGLE_STREAM_GENERATE_PATH_RE =
	/^\/v(?:1beta|1)\/models\/[^/?#]+:streamGenerateContent$/;

export type ApplicationExecutionContext = Pick<
	ExecutionContext,
	"waitUntil"
> & {
	runtimeProfile?: "docker";
};

type ApplicationRequestContext = {
	request: Request;
	env: WorkerEnv;
	cfg: RuntimeConfig;
	url: URL;
	path: string;
};

export async function handleApplicationRequest(
	request: Request,
	env: WorkerEnv,
	executionContext: ApplicationExecutionContext,
): Promise<Response> {
	const method = request.method.toUpperCase();
	const url = new URL(request.url);
	const path = url.pathname;
	const requestId = uuid();
	let activeConfig: RuntimeConfig | undefined;
	let requestStartMs = 0;
	const respond = (response: Response) => {
		const corsResponse = withCORS(response, request);
		const completed = withResponseHeader(
			corsResponse,
			"x-request-id",
			requestId,
		);
		if (activeConfig?.log_requests) {
			logStage(activeConfig, "request_complete", {
				requestId,
				method,
				path,
				status: completed.status,
				ms: elapsedMs(requestStartMs),
			});
		}
		return completed;
	};

	if (method === "OPTIONS") {
		if (path === "/admin" || path.startsWith("/admin/"))
			return new Response(null, {
				status: 204,
				headers: { "Cache-Control": "no-store" },
			});
		return new Response(null, {
			status: 204,
			headers: corsHeaders(request),
		});
	}

	let cfg: RuntimeConfig;
	try {
		cfg = createRuntimeConfig(getConfig(env), {
			execution_ctx: executionContext,
			runtime_profile:
				executionContext.runtimeProfile === "docker" ? "docker" : "worker",
		});
		activeConfig = cfg;
		if (cfg.log_requests) requestStartMs = nowMs();
	} catch (error) {
		return respond(invalidRuntimeConfigResponse(error));
	}

	if (path === "/admin" || path.startsWith("/admin/")) {
		try {
			return withResponseHeader(
				await handleAdminRequest(request, env, cfg),
				"x-request-id",
				requestId,
			);
		} catch (error) {
			log(cfg, `admin error: ${errorLogSummary(error)}`);
			return withResponseHeader(
				jsonResponse(
					{
						error: {
							message: "internal server error",
							code: "internal_server_error",
						},
					},
					500,
				),
				"x-request-id",
				requestId,
			);
		}
	}

	if (path !== "/" && !authorized(request, url, cfg)) {
		return respond(openAIErrorResponse("invalid api key", 401));
	}

	const context: ApplicationRequestContext = {
		request,
		env,
		cfg,
		url,
		path,
	};
	try {
		const response = await dispatchApplicationRoute(method, context);
		return respond(response);
	} catch (error) {
		log(cfg, `error: ${errorLogSummary(error)}`);
		if (error instanceof NoAvailableGeminiSessionError) {
			const message = "no available Gemini account";
			return respond(
				path.startsWith("/v1beta/") || path.startsWith("/v1/models/")
					? jsonResponse(googleJsonError(message, error.code), error.status)
					: openAIErrorResponse(message, error.status, error.code),
			);
		}
		return respond(
			jsonResponse(
				{
					error: {
						message: "internal server error",
						code: "internal_server_error",
					},
				},
				500,
			),
		);
	}
}

function withResponseHeader(
	response: Response,
	name: string,
	value: string,
): Response {
	try {
		response.headers.set(name, value);
		return response;
	} catch (_) {
		const headers = new Headers(response.headers);
		headers.set(name, value);
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	}
}

async function dispatchApplicationRoute(
	method: string,
	context: ApplicationRequestContext,
): Promise<Response> {
	if (method === "GET") return handleGetRoute(context.path);
	if (method === "POST") return handlePostRoute(context);
	return jsonTextResponse(NOT_FOUND_JSON, 404);
}

function handleGetRoute(path: string): Response {
	if (path === "/v1/models") return jsonTextResponse(OPENAI_MODEL_LIST_JSON);
	if (path.startsWith("/v1/models/")) {
		const id = decodeURIComponent(path.slice("/v1/models/".length));
		const modelJson = OPENAI_MODEL_JSON_BY_ID.get(id);
		if (!modelJson)
			return openAIErrorResponse(
				`model ${id} is not available`,
				404,
				"model_not_found",
			);
		return jsonTextResponse(modelJson);
	}
	if (path === "/v1beta/models")
		return jsonTextResponse(GOOGLE_MODEL_LIST_JSON);
	if (path.startsWith("/v1beta/models/")) {
		const id = decodeURIComponent(path.slice("/v1beta/models/".length));
		const modelJson = GOOGLE_MODEL_JSON_BY_ID.get(id);
		if (!modelJson)
			return jsonResponse(
				{
					error: {
						message: `model ${id} is not available`,
						code: "model_not_found",
					},
				},
				404,
			);
		return jsonTextResponse(modelJson);
	}
	if (path === "/") return jsonTextResponse(HEALTH_JSON);
	return jsonTextResponse(NOT_FOUND_JSON, 404);
}

async function handlePostRoute(
	context: ApplicationRequestContext,
): Promise<Response> {
	const { request, env, path } = context;
	if (
		path !== "/v1/chat/completions" &&
		path !== "/v1/responses" &&
		path !== "/v1/images/generations" &&
		path !== "/v1/images/edits" &&
		!GOOGLE_GENERATE_PATH_RE.test(path) &&
		!GOOGLE_STREAM_GENERATE_PATH_RE.test(path)
	)
		return jsonTextResponse(NOT_FOUND_JSON, 404);
	const cfg = await configWithPooledGeminiSession(context.cfg, env);
	if (path === "/v1/chat/completions") {
		return handleOpenAIJsonPost(request, cfg, path, (body) =>
			handleChat(body, cfg, createProvider(cfg)),
		);
	}
	if (path === "/v1/responses") {
		return handleOpenAIJsonPost(request, cfg, path, (body) =>
			handleResponses(body, cfg, createProvider(cfg)),
		);
	}
	if (path === "/v1/images/generations") {
		return handleOpenAIJsonPost(request, cfg, path, (body) =>
			handleImageGenerations(body, cfg, createProvider(cfg)),
		);
	}
	if (path === "/v1/images/edits") {
		if (isMultipartFormRequest(request)) {
			return handleImageEditsMultipart(request, cfg, createProvider(cfg));
		}
		return handleOpenAIJsonPost(request, cfg, path, (body) =>
			handleImageEdits(body, cfg, createProvider(cfg)),
		);
	}
	if (GOOGLE_GENERATE_PATH_RE.test(path)) {
		return handleGoogleJsonPost(request, cfg, path, (body) =>
			handleGoogleGenerate(body, cfg, createProvider(cfg), path, false),
		);
	}
	if (GOOGLE_STREAM_GENERATE_PATH_RE.test(path)) {
		return handleGoogleJsonPost(request, cfg, path, (body) =>
			handleGoogleGenerate(body, cfg, createProvider(cfg), path, true),
		);
	}
	return jsonTextResponse(NOT_FOUND_JSON, 404);
}

function createProvider(cfg: RuntimeConfig) {
	return createGeminiCompletionProvider(cfg);
}

async function handleOpenAIJsonPost(
	request: Request,
	cfg: RuntimeConfig,
	path: string,
	handler: (
		body: NonNullable<RouteJsonPostResult["value"]>,
	) => Promise<Response>,
): Promise<Response> {
	const parsed = await readRouteJsonPost(request, cfg, path);
	if (parsed.error !== undefined)
		return openAIErrorResponse(parsed.error, parsed.status || 400, parsed.code);
	return handler(parsed.value);
}

async function handleGoogleJsonPost(
	request: Request,
	cfg: RuntimeConfig,
	path: string,
	handler: (
		body: NonNullable<RouteJsonPostResult["value"]>,
	) => Promise<Response>,
): Promise<Response> {
	const parsed = await readRouteJsonPost(request, cfg, path);
	if (parsed.error !== undefined)
		return jsonResponse(
			googleJsonError(parsed.error, parsed.code),
			parsed.status || 400,
		);
	return handler(parsed.value);
}

function isMultipartFormRequest(request: Request): boolean {
	const contentType = request.headers.get("content-type") || "";
	return (
		contentType.split(";", 1)[0]?.trim().toLowerCase() === "multipart/form-data"
	);
}

function invalidRuntimeConfigResponse(error: unknown): Response {
	if (error instanceof RuntimeConfigError) {
		return jsonResponse(
			{
				error: {
					message: "invalid runtime configuration",
					code: error.code,
					setting: error.setting,
					reason: error.reason,
				},
			},
			500,
		);
	}
	return jsonResponse(
		{
			error: {
				message: "invalid runtime configuration",
				code: "invalid_runtime_config",
			},
		},
		500,
	);
}
