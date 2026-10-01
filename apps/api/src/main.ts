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
const database = createDatabase(config.DATABASE_URL);
await migrate(database);

const queue = new Queue(queueName, { connection: redisConnection(config.REDIS_URL) });
const dispatcher = createOutboxDispatcher(database, queue, config.OUTBOX_POLL_MS);
const scheduler = createRecoveryScheduler(
  database,
  config.SCHEDULER_POLL_MS,
  config.DISPATCH_RECOVERY_MS,
);
const app = createApp(database, queue);
const server = app.listen(config.API_PORT, () => {
  console.log(`AgentFlow API listening on port ${config.API_PORT}`);
});
dispatcher.start();
scheduler.start();

async function shutdown(signal: string) {
  console.log(`Received ${signal}; shutting down AgentFlow API`);
  server.close();
  await scheduler.stop();
  await dispatcher.stop();
  await database.end();
  await telemetry.shutdown();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
