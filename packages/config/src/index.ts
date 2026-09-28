import { z } from "zod";

const optionalUrl = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().url().optional(),
);

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().url().default("postgresql://agentflow:agentflow@localhost:5432/agentflow"),
  TEST_DATABASE_URL: optionalUrl,
  REDIS_URL: z.string().url().default("redis://localhost:6379"),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  WORKER_ID: z.string().min(1).default(`worker-${process.pid}`),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().max(32).default(2),
  OPERATION_LEASE_MS: z.coerce.number().int().min(1_000).default(15_000),
  ATTEMPT_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(60_000),
  LEASE_HEARTBEAT_MS: z.coerce.number().int().min(100).default(5_000),
  OUTBOX_POLL_MS: z.coerce.number().int().min(100).default(500),
  SCHEDULER_POLL_MS: z.coerce.number().int().min(100).default(2_000),
  DISPATCH_RECOVERY_MS: z.coerce.number().int().min(1_000).default(10_000),
  OTEL_SERVICE_NAME: z.string().min(1).default("agentflow"),
  OTEL_EXPORTER_OTLP_ENDPOINT: optionalUrl,
}).superRefine((environment, context) => {
  if (environment.LEASE_HEARTBEAT_MS >= environment.OPERATION_LEASE_MS) {
    context.addIssue({
      code: "custom",
      path: ["LEASE_HEARTBEAT_MS"],
      message: "LEASE_HEARTBEAT_MS must be less than OPERATION_LEASE_MS",
    });
  }
});

export type AgentFlowConfig = z.infer<typeof environmentSchema>;

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AgentFlowConfig {
  const parsed = environmentSchema.safeParse(environment);
  if (!parsed.success) {
    throw new Error(`Invalid AgentFlow configuration: ${parsed.error.message}`);
  }
  return parsed.data;
}
