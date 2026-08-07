import type { AttachmentPlan } from "../attachments/types";
import type {
	CompletionProvider,
	CompletionProviderOptions,
	CompletionRichOptions,
	CompletionTextInput,
} from "../completion/ports";
import type { RuntimeConfig } from "../config";
import type { ResolvedModel } from "../models";
import { logStage } from "../shared/logging";
import {
	generate,
	generateRich as generateGeminiRich,
	generateStream,
} from "./client";
import {
	abortGeminiSessionRotation,
	configWithFreshGeminiCookie,
} from "./cookies";
import { resolveAttachments, uploadTextFile } from "./uploads";

type ResolvedModelOK = Extract<ResolvedModel, { name: string }>;
type GeminiCompletionProviderDependencies = {
	generate: typeof generate;
	generateRich: typeof generateGeminiRich;
	generateStream: typeof generateStream;
	resolveAttachments: typeof resolveAttachments;
	uploadTextFile: typeof uploadTextFile;
	logStage: typeof logStage;
};

const defaultDependencies: GeminiCompletionProviderDependencies = {
	generate,
	generateRich: generateGeminiRich,
	generateStream,
	resolveAttachments,
	uploadTextFile,
	logStage,
};

export function createGeminiCompletionProvider(
	cfg: RuntimeConfig,
): CompletionProvider {
	return createGeminiCompletionProviderWithDependencies(
		cfg,
		defaultDependencies,
	);
}

export function createGeminiCompletionProviderWithDependenciesForTest(
	cfg: RuntimeConfig,
	dependencies: GeminiCompletionProviderDependencies,
): CompletionProvider {
	return createGeminiCompletionProviderWithDependencies(cfg, dependencies);
}

function createGeminiCompletionProviderWithDependencies(
	cfg: RuntimeConfig,
	dependencies: GeminiCompletionProviderDependencies,
): CompletionProvider {
	let activeConfigPromise: Promise<RuntimeConfig> | null = null;
	const activeConfig = (): Promise<RuntimeConfig> => {
		activeConfigPromise ||= configWithFreshGeminiCookie(cfg);
		return activeConfigPromise;
	};
	return {
		supportsAuthenticatedSession: !!cfg.cookie,
		async generateText(input: CompletionTextInput) {
			const model = requireResolvedModel(input.rm);
			const activeCfg = await activeConfig();
			if (cfg.log_requests)
				logGeminiRoute(dependencies.logStage, cfg, model, false);
			return dependencies.generate(
				activeCfg,
				input.prompt,
				model.modeId,
				model.thinkMode,
				model.extra,
				input.fileRefs,
				model.modelHeaders,
			);
		},
		async generateRich(
			input: CompletionTextInput,
			options: CompletionRichOptions = {},
		) {
			const model = requireResolvedModel(input.rm);
			const activeCfg = await activeConfig();
			if (cfg.log_requests)
				logGeminiRoute(dependencies.logStage, cfg, model, false);
			return dependencies.generateRich(
				activeCfg,
				input.prompt,
				model.modeId,
				model.thinkMode,
				model.extra,
				input.fileRefs,
				model.modelHeaders,
				options,
			);
		},
		async *streamText(
			input: CompletionTextInput,
			options: CompletionProviderOptions = {},
		) {
			const model = requireResolvedModel(input.rm);
			const activeCfg = await activeConfig();
			if (cfg.log_requests)
				logGeminiRoute(dependencies.logStage, cfg, model, true);
			for await (const delta of dependencies.generateStream(
				activeCfg,
				input.prompt,
				model.modeId,
				model.thinkMode,
				model.extra,
				input.fileRefs,
				options,
				model.modelHeaders,
			)) {
				const text = String(delta || "");
				if (text) yield text;
			}
		},
		async resolveAttachments(plan: AttachmentPlan) {
			return dependencies.resolveAttachments(await activeConfig(), plan);
		},
		async uploadTextFile(text: string, filename: string) {
			return dependencies.uploadTextFile(await activeConfig(), text, filename);
		},
		async dispose() {
			if (!activeConfigPromise) return;
			await abortGeminiSessionRotation(await activeConfigPromise);
		},
	};
}

function requireResolvedModel(rm: ResolvedModel): ResolvedModelOK {
	if (rm.name === undefined)
		throw new Error(rm.error || "model is not resolved");
	return rm;
}

function logGeminiRoute(
	writeLogStage: typeof logStage,
	cfg: RuntimeConfig,
	model: ResolvedModelOK,
	stream: boolean,
): void {
	writeLogStage(cfg, "gemini_route", {
		model: model.name,
		modelFamily: model.modeId,
		thinkingMode: model.thinkMode,
		enhancedMode: model.extra ? model.extra[31] : undefined,
		enhancedRouting: model.extra ? model.extra[80] : undefined,
		webModelHeader: !!model.modelHeaders,
		stream,
	});
}
