import { ensureAdminUser, readCredentials } from "./auth.js";
import { telemetry } from "./instrumentation.js";
import { loadConfig } from "@agentflow/config";
import { createDatabase, migrate } from "@agentflow/db";
import { queueName } from "@agentflow/shared";
import { Queue } from "bullmq";
import { createApp } from "./app.js";
import { createOutboxDispatcher } from "./outbox.js";
import { redisConnection } from "./redis.js";
import { createRecoveryScheduler } from "./scheduler.js";

const config = loadConfig();
const credentials = readCredentials();
if (credentials.length === 0 && !config.AGENTFLOW_ADMIN_PASSWORD) {
  throw new Error("Configure AGENTFLOW_AUTH_CREDENTIALS or AGENTFLOW_ADMIN_PASSWORD before starting the API");
}
const database = createDatabase(config.DATABASE_URL);
await migrate(database);
await ensureAdminUser(database, config.AGENTFLOW_ADMIN_PASSWORD, config.AGENTFLOW_ADMIN_USERNAME);

const queue = new Queue(queueName, { connection: redisConnection(config.REDIS_URL) });
// Redis outages surface here; PostgreSQL outbox rows remain the durable dispatch intent.
queue.on("error", (error) => {
  console.error("Operation queue connection error", error);
});
const dispatcher = createOutboxDispatcher(database, queue, config.OUTBOX_POLL_MS);
const scheduler = createRecoveryScheduler(
  database,
  config.SCHEDULER_POLL_MS,
  config.DISPATCH_RECOVERY_MS,
);
const app = createApp(database, queue, credentials);
const server = app.listen(config.API_PORT, () => {
  console.log(`AgentFlow API listening on port ${config.API_PORT}`);
});
server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${config.API_PORT} is already in use. Check if Docker container agentflow-api-1 or another process is occupying it.`);
  } else {
    console.error("AgentFlow API server error:", error);
  }
  process.exit(1);
});
dispatcher.start();
scheduler.start();

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; shutting down AgentFlow API`);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await scheduler.stop();
  await dispatcher.stop();
  await database.end();
  await telemetry.shutdown();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
