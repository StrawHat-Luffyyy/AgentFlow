import { loadConfig } from "@agentflow/config";
import { createDatabase, migrate } from "@agentflow/db";
import {
  AgentHarness,
  OllamaProvider,
  OpenAIResponsesProvider,
  ProviderRegistry,
  ToolRegistry,
} from "@agentflow/harness";
import { ScriptedResearchProvider } from "@agentflow/research";
import type { ConnectionOptions } from "bullmq";
import { createOperationWorker } from "./worker.js";

function redisConnection(redisUrl: string): ConnectionOptions {
  const url = new URL(redisUrl);
  const connection: ConnectionOptions = { host: url.hostname, port: Number(url.port || 6379) };
  if (url.username) connection.username = decodeURIComponent(url.username);
  if (url.password) connection.password = decodeURIComponent(url.password);
  if (url.pathname.length > 1) connection.db = Number(url.pathname.slice(1));
  if (url.protocol === "rediss:") connection.tls = {};
  return connection;
}

const config = loadConfig();
const database = createDatabase(config.DATABASE_URL);
await migrate(database);

const providers = new ProviderRegistry()
  .register(new ScriptedResearchProvider())
  .register(new OllamaProvider({ baseUrl: config.OLLAMA_BASE_URL }));
if (config.OPENAI_API_KEY) {
  providers.register(new OpenAIResponsesProvider({
    apiKey: config.OPENAI_API_KEY,
    baseUrl: config.OPENAI_BASE_URL,
  }));
}
const harness = new AgentHarness(providers, new ToolRegistry());

const worker = createOperationWorker({
  database,
  connection: redisConnection(config.REDIS_URL),
  workerId: config.WORKER_ID,
  leaseMs: config.OPERATION_LEASE_MS,
  attemptTimeoutMs: config.ATTEMPT_TIMEOUT_MS,
  heartbeatMs: config.LEASE_HEARTBEAT_MS,
  concurrency: config.WORKER_CONCURRENCY,
  harness,
});

worker.on("completed", (job, result) => {
  console.log("Operation delivery completed", { jobId: job.id, result });
});
worker.on("failed", (job, error) => {
  console.error("Operation delivery failed", { jobId: job?.id, error });
});
console.log(`AgentFlow worker ${config.WORKER_ID} started`);

async function shutdown(signal: string) {
  console.log(`Received ${signal}; shutting down AgentFlow worker`);
  await worker.close();
  await database.end();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
