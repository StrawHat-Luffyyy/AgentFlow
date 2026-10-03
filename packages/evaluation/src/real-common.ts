import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createDatabase, type Database } from "@agentflow/db";
import { ScriptedResearchProvider, cloudComparisonWorkflowDefinition, executeReferenceTransform } from "@agentflow/research";
import { canonicalJson, type WorkflowStepDefinition } from "@agentflow/shared";
import { AgentHarness, ProviderRegistry, ToolRegistry, type LLMRequest, type ProviderExecutionContext } from "@agentflow/harness";
import { AttemptTimeoutError, RetryableOperationError, publishToControlledReceiver } from "@agentflow/runtime";

export type RealSystem = "B0" | "B1" | "A0" | "A1" | "DBOS";
export type RealScenario = "E0" | "E1" | "E2" | "E3" | "E4" | "E5" | "E6" | "E7" | "DEMO";
export interface RealConfig {
  trialId: string; system: RealSystem; scenario: RealScenario; databaseUrl: string;
  dbosUrl: string; queue: string; redisUrl: string; runId?: string;
  leaseMs: number; retryMs: number; operationDelayMs: number; observationMs: number;
}
export const definition = cloudComparisonWorkflowDefinition();
export const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
export const publicationTarget = (id: string) => `controlled://publications/${id.toLowerCase()}`;

export async function installEvidenceSchema(db: Database): Promise<void> {
  await db.query(`CREATE TABLE IF NOT EXISTS evaluation_trials (
    id text PRIMARY KEY, system text NOT NULL, scenario text NOT NULL, run_id uuid,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(), approved_hash text,
    outcome text, error text, finished_at timestamptz);
    CREATE TABLE IF NOT EXISTS evaluation_events (
    sequence bigserial PRIMARY KEY, trial_id text NOT NULL, event text NOT NULL,
    operation text, pid integer NOT NULL, at timestamptz NOT NULL DEFAULT clock_timestamp(),
    detail jsonb NOT NULL DEFAULT '{}');
    CREATE INDEX IF NOT EXISTS evaluation_events_trial_idx ON evaluation_events(trial_id, sequence);
    CREATE TABLE IF NOT EXISTS evaluation_faults (
    trial_id text NOT NULL, fault text NOT NULL, hits integer NOT NULL, PRIMARY KEY(trial_id, fault));`);
}

export class Evidence {
  constructor(readonly db: Database, readonly config: RealConfig) {}
  async event(event: string, operation: string | null = null, detail: unknown = {}): Promise<void> {
    await this.db.query("INSERT INTO evaluation_events(trial_id,event,operation,pid,detail) VALUES($1,$2,$3,$4,$5::jsonb)",
      [this.config.trialId, event, operation, process.pid, JSON.stringify(detail)]);
  }
  async fault(boundary: string, operation: string): Promise<void> {
    const scenario = this.config.scenario;
    let action: "crash" | "transient" | "timeout" | null = null;
    let repeats = 1;
    if ((scenario === "E1" || scenario === "DEMO") && boundary === "before-operation" && operation === "analyze-features") action = "crash";
    if (scenario === "E2" && boundary === "after-provider-response" && operation === "analyze-features") action = "crash";
    if (scenario === "E3" && boundary === "before-operation" && operation === "analyze-pricing") { action = "transient"; repeats = 2; }
    if (scenario === "E4" && boundary === "before-operation" && operation === "search-azure") action = "timeout";
    if (["E5", "E6", "DEMO"].includes(scenario) && boundary === "after-receiver-commit" && operation === "publish-report") action = "crash";
    if (!action) return;
    const fault = `${boundary}:${operation}`;
    const hit = await this.db.query<{ hits: number }>(`INSERT INTO evaluation_faults VALUES($1,$2,1)
      ON CONFLICT(trial_id,fault) DO UPDATE SET hits=evaluation_faults.hits+1 RETURNING hits`, [this.config.trialId, fault]);
    if (hit.rows[0]!.hits > repeats) return;
    await this.event("fault", operation, { boundary, action, occurrence: hit.rows[0]!.hits });
    if (action === "crash") { process.kill(process.pid, "SIGKILL"); await new Promise(() => {}); }
    if (action === "timeout") { await delay(50); throw new AttemptTimeoutError("Injected read timeout"); }
    throw new RetryableOperationError("Injected dependency 503", "INJECTED_503");
  }
  async boundary(boundary: string, operation: string, detail: unknown = {}): Promise<void> {
    await this.event(boundary, operation, detail);
    await this.fault(boundary, operation);
    if (boundary === "before-operation" && this.config.operationDelayMs) await delay(this.config.operationDelayMs);
  }
}

export function measuredHarness(evidence: Evidence): AgentHarness {
  class MeasuredProvider extends ScriptedResearchProvider {
    override async execute(request: LLMRequest, context: ProviderExecutionContext) {
      const key = request.instructions?.includes(":pricing]") ? "analyze-pricing" : "analyze-features";
      await evidence.event("provider-start", key);
      const response = await super.execute(request, context);
      await evidence.event("provider-result", key, { usage: response.usage, outputHash: digest(response.text) });
      return response;
    }
  }
  return new AgentHarness(new ProviderRegistry().register(new MeasuredProvider()), new ToolRegistry());
}

export async function executeCommonOperation(
  step: WorkflowStepDefinition, input: Record<string, unknown>, evidence: Evidence,
): Promise<Record<string, unknown>> {
  await evidence.boundary("before-operation", step.key);
  if (step.kind === "DETERMINISTIC") return executeReferenceTransform(step.handler, input);
  if (step.kind === "AGENT") {
    const response = await measuredHarness(evidence).executeModelOperation({
      provider: step.provider, request: { model: step.model, instructions: step.instructions,
        messages: [{ role: "user", content: JSON.stringify(input) }], maxOutputTokens: step.maxOutputTokens! },
      allowedTools: step.allowedTools, turn: 1, maxTurns: step.maxTurns,
      context: { runId: evidence.config.trialId, logicalOperationId: step.key, attemptId: randomUUID(), deadlineAt: new Date(Date.now() + 60_000) },
    });
    await evidence.boundary("after-provider-response", step.key);
    return { ...input, [step.outputKey!]: { content: response.text, finishReason: response.finishReason,
      provider: step.provider, model: response.resolvedModel, turns: 1 } };
  }
  if (step.kind === "APPROVAL") {
    const payloadHash = digest(input);
    await evidence.event("approval-waiting", step.key, { payloadHash });
    while (true) {
      const approval = await evidence.db.query<{ approved_hash: string | null }>("SELECT approved_hash FROM evaluation_trials WHERE id=$1", [evidence.config.trialId]);
      if (approval.rows[0]?.approved_hash === payloadHash) break;
      await delay(20);
    }
    await evidence.event("approval-accepted", step.key, { payloadHash });
    return input;
  }
  const approved = await evidence.db.query<{ approved_hash: string }>("SELECT approved_hash FROM evaluation_trials WHERE id=$1", [evidence.config.trialId]);
  if (approved.rows[0]?.approved_hash !== digest(input)) throw new Error("Publication lacks exact approval");
  await evidence.event("effect-send", step.key, { payloadHash: digest(input), approved: true });
  const stable = evidence.config.system !== "B0" && evidence.config.scenario !== "E6";
  const result = await publishToControlledReceiver(evidence.db, {
    toolExecutionId: randomUUID(), idempotencyRecordId: randomUUID(), requestHash: digest(input),
    key: `evaluation:${evidence.config.trialId}:publish-report`, receiverNamespace: "controlled-publication-v1",
    effectClass: stable ? "RECEIVER_IDEMPOTENT_WRITE" : "UNSAFE_WRITE",
  }, input);
  await evidence.boundary("after-receiver-commit", step.key, result);
  return { published: true, receiverId: result.receiverId, receipt: result.receipt, receiverReplayed: result.replayed };
}

export function evidenceDatabase(url: string): Database {
  if (!new URL(url).pathname.endsWith("_eval")) throw new Error("Real experiments require a dedicated database ending in _eval");
  return createDatabase(url);
}
