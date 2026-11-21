// Starts an isolated AgentFlow stack for the Playwright console tests: its own database
// (agentflow_e2e_test), Redis logical DB 1 (so the fixed queue never meets dev workers),
// the API on E2E_API_PORT, and one worker. Playwright's webServer runs this and stops it.
//
// E2E_FAULT_PLAN (optional): the first worker runs with that AGENTFLOW_FAULT_PLAN and, when it
// dies, a normal replacement worker starts, like the evaluation supervisor. Used to capture a
// crash-recovered run for the README screenshots.
import { spawn, type ChildProcess } from "node:child_process";
import { createDatabase, migrate } from "@agentflow/db";
import { queueName } from "@agentflow/shared";
import { Queue } from "bullmq";
import { redisConnection } from "../../apps/api/src/redis.ts";
import { e2eEnvironment } from "./env.ts";

const environment = e2eEnvironment();
const databaseUrl = environment.DATABASE_URL;
const databaseName = new URL(databaseUrl).pathname.slice(1);
if (!/(?:_|-)test$/.test(databaseName)) {
  throw new Error(`Refusing to reset non-test database "${databaseName}"; it must end in _test or -test.`);
}

async function prepareDatabase(): Promise<void> {
  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = "/postgres";
  const admin = createDatabase(adminUrl.toString());
  try {
    const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [databaseName]);
    if (exists.rowCount === 0) await admin.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await admin.end();
  }
  const database = createDatabase(databaseUrl);
  try {
    await migrate(database);
    await database.query(`
      TRUNCATE research_sources, tool_executions, idempotency_records, controlled_publication_effects,
        approvals, audit_events, outbox, checkpoints, step_attempts, workflow_steps,
        workflow_runs, workflow_versions, workflows, web_sessions, worker_heartbeats CASCADE
    `);
  } finally {
    await database.end();
  }
  const queue = new Queue(queueName, { connection: redisConnection(environment.REDIS_URL) });
  await queue.obliterate({ force: true });
  await queue.close();
}

const children = new Set<ChildProcess>();

function start(name: string, entry: string, extra: Record<string, string> = {}): ChildProcess {
  const child = spawn(process.execPath, ["--import", "tsx", entry], {
    env: { ...process.env, ...environment, ...extra },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const prefix = (line: string) => `[${name}] ${line}`;
  child.stdout?.on("data", (chunk: Buffer) => process.stdout.write(chunk.toString().split("\n").filter(Boolean).map(prefix).join("\n") + "\n"));
  child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk.toString().split("\n").filter(Boolean).map(prefix).join("\n") + "\n"));
  children.add(child);
  child.on("exit", () => children.delete(child));
  return child;
}

function stopAll(): void {
  for (const child of children) child.kill();
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { stopAll(); process.exit(0); });
process.on("exit", stopAll);

await prepareDatabase();
start("api", "apps/api/src/main.ts");
const faultPlan = process.env.E2E_FAULT_PLAN;
if (faultPlan) {
  const faulty = start("worker-faulty", "apps/worker/src/main.ts", { AGENTFLOW_FAULT_PLAN: faultPlan, WORKER_ID: "e2e-worker-1" });
  faulty.on("exit", (code, signal) => {
    console.log(`[stack] faulty worker exited (${signal ?? code}); starting replacement`);
    start("worker", "apps/worker/src/main.ts", { WORKER_ID: "e2e-worker-2" });
  });
} else {
  start("worker", "apps/worker/src/main.ts", { WORKER_ID: "e2e-worker-1" });
}
// Stay alive while the children run; Playwright stops this process when the tests finish.
setInterval(() => undefined, 60_000);
