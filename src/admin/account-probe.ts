import type { GeminiSessionLease, RuntimeConfig } from "../config";
import { extractGeminiAppPageTokens } from "../gemini/app-page";
import { GEMINI_WEB_USER_AGENT } from "../gemini/constants";
import { httpFetch } from "../gemini/transport";

export type GeminiAccountProbeResult = Readonly<{
	account_id: string;
	ok: boolean;
	latency_ms: number;
	issue: "" | "auth" | "rate_limit" | "transient";
	upstream_status?: number;
}>;

export async function probeGeminiAccount(
	cfg: RuntimeConfig,
	lease: GeminiSessionLease,
): Promise<GeminiAccountProbeResult> {
	const startedAt = performance.now();
	try {
		const response = await httpFetch(`${cfg.gemini_origin}/app`, {
			headers: {
				"User-Agent": GEMINI_WEB_USER_AGENT,
				"Accept-Language": "en-US,en;q=0.9",
				Cookie: lease.cookie,
			},
			timeoutMs: Math.min(cfg.request_timeout_sec * 1000, 30_000),
			socket: cfg.upstream_socket,
			cfg,
		});
		const status = Number(response.status);
		if (status === 401 || status === 403)
			return probeResult(lease, startedAt, false, "auth", status);
		if (status === 402 || status === 429)
			return probeResult(lease, startedAt, false, "rate_limit", status);
		if (status < 200 || status >= 300)
			return probeResult(lease, startedAt, false, "transient", status);
		const tokens = await extractGeminiAppPageTokens(response);
		return tokens.at
			? probeResult(lease, startedAt, true, "", status)
			: probeResult(lease, startedAt, false, "auth", status);
	} catch (_) {
		return probeResult(lease, startedAt, false, "transient");
	}
}

function probeResult(
	lease: GeminiSessionLease,
	startedAt: number,
	ok: boolean,
	issue: GeminiAccountProbeResult["issue"],
	upstreamStatus?: number,
): GeminiAccountProbeResult {
	const result: {
		account_id: string;
		ok: boolean;
		latency_ms: number;
		issue: GeminiAccountProbeResult["issue"];
		upstream_status?: number;
	} = {
		account_id: lease.account_id,
		ok,
		latency_ms: Math.max(0, Math.round(performance.now() - startedAt)),
		issue,
	};
	if (typeof upstreamStatus === "number" && Number.isFinite(upstreamStatus))
		result.upstream_status = upstreamStatus;
	return result;
}
