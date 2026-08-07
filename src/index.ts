import { handleApplicationRequest } from "./app";
import type { WorkerEnv } from "./config";

export { GeminiSessionPool } from "./gemini/session-pool";

export default {
	fetch: handleApplicationRequest,
} satisfies ExportedHandler<WorkerEnv>;
