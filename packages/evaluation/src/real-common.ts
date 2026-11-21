import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createDatabase, type Database } from "@agentflow/db";
import {
  ScriptedResearchProvider, ScriptedToolResearchProvider, TOOL_RESEARCH_STEP, TOOL_RESEARCH_TAG, cloudComparisonWorkflowDefinition,
  executeReferenceTransform, readSourceTool, toolResearchWorkflowDefinition,
} from "@agentflow/research";
import { canonicalJson, projectAgentInput, type WorkflowStepDefinition } from "@agentflow/shared";
import {
  AgentHarness,
  GeminiProvider,
  GroqProvider,
  ProviderError,
  ProviderRegistry,
  ToolRegistry,
  type JsonObject,
  type LLMMessage,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
  type ProviderExecutionContext,
} from "@agentflow/harness";
import {
  AttemptTimeoutError,
  PermanentOperationError,
  RetryableOperationError,
  publishToControlledReceiver,
} from "@agentflow/runtime";

/**
 * Systems in the real-process campaign.
 * - B0/B1: volatile baselines (B1 with a stable receiver key).
 * - A0/A1: AgentFlow (A0 without receiver cooperation).
 * - A1-nojournal: evaluation-only ablation of A1 with LLM journal replay and the cache off.
 * - A1-cache: A1 on a cacheScope "version" workflow version (scenario R1 only).
 * - DBOS: the DBOS SDK, one durable step per workflow step.
 * - C1: Temporal-style in-repo baseline, every step and every LLM call (and agent tool call) a recorded activity.
 * - C1-step: Temporal-style with the whole agent loop inside one step activity (no per-call history).
 * - C2: LangGraph-style in-repo baseline, a full-state checkpoint after each node.
 */
export const realSystems = ["B0", "B1", "A0", "A1", "A1-nojournal", "A1-cache", "DBOS", "C1", "C1-step", "C2"] as const;
export type RealSystem = (typeof realSystems)[number];
export const realScenarios = ["E0", "E1", "E2", "E2B", "E3", "E4", "E5", "E6", "E7", "E8", "R1", "DEMO"] as const;
export type RealScenario = (typeof realScenarios)[number];
export type RealProvider = "scripted" | "gemini" | "groq";
/**
 * Evaluation workloads. "cloud-comparison" is the reference workflow behind all cited campaigns
 * (one LLM call per AGENT step). "tool-research" has one AGENT step that makes five LLM calls
 * (four tool lookups, then the answer); scripted provider only.
 */
export const realWorkloads = ["cloud-comparison", "tool-research"] as const;
export type RealWorkload = (typeof realWorkloads)[number];
/** Scenarios the tool-research workload defines faults for. */
export const toolResearchScenarios: readonly RealScenario[] = ["E0", "E1", "E2", "E2B"];

/** Systems executed by the AgentFlow API + worker processes (the others run the baseline role). */
export const isAgentFlowSystem = (system: RealSystem) =>
  system === "A0" || system === "A1" || system === "A1-nojournal" || system === "A1-cache";

export interface RealConfig {
  trialId: string; system: RealSystem; scenario: RealScenario; databaseUrl: string;
  dbosUrl: string; queue: string; redisUrl: string; runId?: string;
  leaseMs: number; retryMs: number; operationDelayMs: number; observationMs: number;
  apiPort?: number;
  /** Reference workflow context mode (brief §2.4). Absent means "full", the pre-2.4 prompts. */
  context?: "minimal" | "full";
  /** LLM provider for AGENT steps. Absent means the deterministic scripted provider. */
  provider?: RealProvider;
  /** Model id for a live provider (ignored for scripted). */
  model?: string;
  /** Absent means "cloud-comparison". */
  workload?: RealWorkload;
  /** tool-research: the 1-based LLM call in the investigate loop that E2/E2B crash after (default 3). */
  crashTurn?: number;
}

/** The reference definition every system runs; scripted "full" reproduces the cited campaigns' definition. */
export function referenceDefinition(config: Pick<RealConfig, "context" | "provider" | "model" | "workload">) {
  if (config.workload === "tool-research") return toolResearchWorkflowDefinition();
  const provider = config.provider ?? "scripted";
  return cloudComparisonWorkflowDefinition({
    context: config.context ?? "full",
    ...(provider === "scripted" ? {} : { mode: "live" as const, provider, model: config.model! }),
  });
}

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
    trial_id text NOT NULL, fault text NOT NULL, hits integer NOT NULL, PRIMARY KEY(trial_id, fault));
    CREATE TABLE IF NOT EXISTS evaluation_activity_history (
    trial_id text NOT NULL, activity_key text NOT NULL, result_json jsonb NOT NULL,
    completed_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(trial_id, activity_key));
    CREATE TABLE IF NOT EXISTS evaluation_node_checkpoints (
    trial_id text NOT NULL, position integer NOT NULL, node_key text NOT NULL, state_json jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(trial_id, position));`);
}

export class Evidence {
  constructor(readonly db: Database, readonly config: RealConfig) {}
  async event(event: string, operation: string | null = null, detail: unknown = {}): Promise<void> {
    await this.db.query("INSERT INTO evaluation_events(trial_id,event,operation,pid,detail) VALUES($1,$2,$3,$4,$5::jsonb)",
      [this.config.trialId, event, operation, process.pid, JSON.stringify(detail)]);
  }
  /** Increments a per-trial counter that survives process restarts. */
  async hit(fault: string): Promise<number> {
    const hit = await this.db.query<{ hits: number }>(`INSERT INTO evaluation_faults VALUES($1,$2,1)
      ON CONFLICT(trial_id,fault) DO UPDATE SET hits=evaluation_faults.hits+1 RETURNING hits`, [this.config.trialId, fault]);
    return hit.rows[0]!.hits;
  }
  async fault(boundary: string, operation: string, turn?: number): Promise<void> {
    const scenario = this.config.scenario;
    let action: "crash" | "transient" | "timeout" | null = null;
    let repeats = 1;
    if (this.config.workload === "tool-research") {
      // One agent step, five LLM calls: E1 crashes before it starts, E2/E2B after call crashTurn.
      const crashTurn = this.config.crashTurn ?? 3;
      if (operation !== TOOL_RESEARCH_STEP) return;
      if (scenario === "E1" && boundary === "before-operation") action = "crash";
      if (scenario === "E2" && boundary === "after-provider-response" && turn === crashTurn) action = "crash";
      if (scenario === "E2B" && boundary === "after-llm-journal-commit" && turn === crashTurn) action = "crash";
      if (!action) return;
      const hits = await this.hit(`${boundary}:${operation}${turn === undefined ? "" : `#${turn}`}`);
      if (hits > repeats) return;
      await this.event("fault", operation, { boundary, action, occurrence: hits, ...(turn === undefined ? {} : { turn }) });
      process.kill(process.pid, "SIGKILL");
      await new Promise(() => {});
    }
    if ((scenario === "E1" || scenario === "DEMO") && boundary === "before-operation" && operation === "analyze-features") action = "crash";
    if (scenario === "E2" && boundary === "after-provider-response" && operation === "analyze-features") action = "crash";
    if (scenario === "E2B" && boundary === "after-llm-journal-commit" && operation === "analyze-features") action = "crash";
    if (scenario === "E3" && boundary === "before-operation" && operation === "analyze-pricing") { action = "transient"; repeats = 2; }
    if (scenario === "E4" && boundary === "before-operation" && operation === "search-azure") action = "timeout";
    if (["E5", "E6", "DEMO"].includes(scenario) && boundary === "after-receiver-commit" && operation === "publish-report") action = "crash";
    if (!action) return;
    const hits = await this.hit(`${boundary}:${operation}`);
    if (hits > repeats) return;
    await this.event("fault", operation, { boundary, action, occurrence: hits });
    if (action === "crash") { process.kill(process.pid, "SIGKILL"); await new Promise(() => {}); }
    if (action === "timeout") { await delay(50); throw new AttemptTimeoutError("Injected read timeout"); }
    throw new RetryableOperationError("Injected dependency 503", "INJECTED_503");
  }
  async boundary(boundary: string, operation: string, detail: unknown = {}): Promise<void> {
    await this.event(boundary, operation, detail);
    const turn = typeof detail === "object" && detail !== null && typeof (detail as { turn?: unknown }).turn === "number"
      ? (detail as { turn: number }).turn : undefined;
    await this.fault(boundary, operation, turn);
    if (boundary === "before-operation" && this.config.operationDelayMs) await delay(this.config.operationDelayMs);
  }
}

/** E8: the first two pricing calls are rejected with HTTP 429 (not billed by any provider). */
export const e8RejectedCalls = 2;

function createProvider(config: RealConfig): LLMProvider {
  const provider = config.provider ?? "scripted";
  if (provider === "gemini") return new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY, model: config.model });
  if (provider === "groq") return new GroqProvider({ apiKey: process.env.GROQ_API_KEY, model: config.model });
  return config.workload === "tool-research" ? new ScriptedToolResearchProvider() : new ScriptedResearchProvider();
}

/**
 * Wraps the campaign's provider so every call leaves evidence: provider-start, then
 * provider-result (normalized usage with provenance, resolved model, output hash) or
 * provider-error. Errors are recorded as not billed unless the outcome is unknown.
 */
export class MeasuredProvider implements LLMProvider {
  readonly name: string;
  readonly adapterVersion: string;
  readonly capabilities: LLMProvider["capabilities"];
  constructor(private readonly inner: LLMProvider, private readonly evidence: Evidence) {
    this.name = inner.name;
    this.adapterVersion = inner.adapterVersion;
    this.capabilities = inner.capabilities;
  }

  async execute(request: LLMRequest, context: ProviderExecutionContext): Promise<LLMResponse> {
    const instructions = request.instructions ?? "";
    const key = instructions.includes(TOOL_RESEARCH_TAG) ? TOOL_RESEARCH_STEP
      : instructions.includes(":pricing]") ? "analyze-pricing" : "analyze-features";
    // Each agent turn appends one assistant message, so this is the 1-based LLM call within the step.
    const turn = request.messages.filter((message) => message.role === "assistant").length + 1;
    await this.evidence.event("provider-start", key, { turn });
    if (this.evidence.config.scenario === "E8" && key === "analyze-pricing" &&
        await this.evidence.hit("provider-429:analyze-pricing") <= e8RejectedCalls) {
      const error = new ProviderError("Injected HTTP 429 rate limit", "TRANSIENT", "PROVIDER_HTTP_429", 429, 50);
      await this.evidence.event("provider-error", key, { turn, code: error.code, status: 429, errorClass: "TRANSIENT", billed: false, injected: true });
      throw error;
    }
    let response: LLMResponse;
    try {
      response = await this.inner.execute(request, context);
    } catch (error) {
      const providerError = error instanceof ProviderError ? error : null;
      await this.evidence.event("provider-error", key, {
        turn,
        code: providerError?.code ?? "PROVIDER_EXECUTION_ERROR",
        status: providerError?.status ?? null,
        errorClass: providerError?.errorClass ?? "UNKNOWN",
        billed: providerError?.outcomeUnknown ? "unknown" : false,
        injected: false,
      });
      throw error;
    }
    const { raw: _raw, ...usage } = response.usage;
    await this.evidence.event("provider-result", key, {
      turn, usage, resolvedModel: response.resolvedModel, outputHash: digest(response.text),
    });
    return response;
  }
}

export function measuredHarness(evidence: Evidence): AgentHarness {
  return new AgentHarness(
    new ProviderRegistry().register(new MeasuredProvider(createProvider(evidence.config), evidence)),
    // read-source is the PURE fixed-corpus lookup of the tool-research workload.
    new ToolRegistry().register(readSourceTool),
  );
}

/**
 * Durable activity history for the Temporal-style C1 baseline: one activity per LLM call
 * (`<step>:llm:<turn>`) and per agent tool call (`<step>:tool:<turn>`).
 */
export interface LlmRecorder {
  lookup(key: string): Promise<LLMResponse | null>;
  store(key: string, response: LLMResponse): Promise<void>;
  lookupTool(key: string): Promise<Record<string, unknown> | null>;
  storeTool(key: string, output: Record<string, unknown>): Promise<void>;
}

/** Same classification as the AgentFlow worker, so every system retries provider errors alike. */
function mapProviderError(error: unknown): Error {
  if (!(error instanceof ProviderError)) return error instanceof Error ? error : new Error(String(error));
  if (error.errorClass === "TIMEOUT") return new AttemptTimeoutError(error.message);
  if (error.errorClass === "TRANSIENT") return new RetryableOperationError(error.message, error.code, error.retryAfterMs ?? undefined);
  return new PermanentOperationError(error.message, error.code);
}

export async function executeCommonOperation(
  step: WorkflowStepDefinition, input: Record<string, unknown>, evidence: Evidence,
  options: { llmRecorder?: LlmRecorder } = {},
): Promise<Record<string, unknown>> {
  await evidence.boundary("before-operation", step.key);
  if (step.kind === "DETERMINISTIC") return executeReferenceTransform(step.handler, input);
  if (step.kind === "AGENT") return executeCommonAgentLoop(step, input, evidence, options);
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

/**
 * The baselines' agent loop, mirroring the AgentFlow worker's executeBoundedAgentOperation:
 * one LLM call per turn, at most one tool call per response, stop on a response without tool
 * calls, bounded by maxTurns. Every system therefore sends identical prompts. Only C1 passes a
 * recorder; everywhere else a response or tool result lives in memory until the step ends.
 * With the single-call cloud-comparison workload this is exactly the previous one-call path.
 */
async function executeCommonAgentLoop(
  step: Extract<WorkflowStepDefinition, { kind: "AGENT" }>, input: Record<string, unknown>, evidence: Evidence,
  options: { llmRecorder?: LlmRecorder },
): Promise<Record<string, unknown>> {
  const harness = measuredHarness(evidence);
  const recorder = options.llmRecorder;
  // Same projection as the AgentFlow worker, so every system sends an identical prompt.
  const messages: LLMMessage[] = [{ role: "user", content: JSON.stringify(step.inputs ? projectAgentInput(input, step.inputs) : input) }];
  let opaqueState: JsonObject | undefined;
  for (let turn = 1; turn <= step.maxTurns!; turn += 1) {
    const activityKey = `${step.key}:llm:${turn}`;
    let response = await recorder?.lookup(activityKey) ?? null;
    if (response) {
      await evidence.event("activity-replayed", step.key, { activityKey, turn });
    } else {
      try {
        response = await harness.executeModelOperation({
          provider: step.provider!, request: { model: step.model!, instructions: step.instructions!, messages: [...messages],
            maxOutputTokens: step.maxOutputTokens!,
            ...(step.temperature === undefined ? {} : { temperature: step.temperature }),
            ...(step.seed === undefined ? {} : { seed: step.seed }),
            ...(opaqueState === undefined ? {} : { opaqueState }) },
          allowedTools: step.allowedTools!, turn, maxTurns: step.maxTurns!,
          context: { runId: evidence.config.trialId, logicalOperationId: turn === 1 ? step.key : `${step.key}#${turn}`,
            attemptId: randomUUID(), deadlineAt: new Date(Date.now() + 60_000) },
        });
      } catch (error) {
        throw mapProviderError(error);
      }
      await evidence.boundary("after-provider-response", step.key, { turn });
      // Without a recorder (B0/B1/DBOS/C1-step/C2) the response exists only in memory here, so
      // "journal committed" is the same instant as "response received". C1 records it first.
      if (recorder) await recorder.store(activityKey, response);
      await evidence.boundary("after-llm-journal-commit", step.key, { turn });
    }
    opaqueState = response.opaqueState ?? undefined;
    if (response.toolCalls.length === 0) {
      return { ...input, [step.outputKey!]: { content: response.text, finishReason: response.finishReason,
        provider: step.provider, model: response.resolvedModel, turns: turn } };
    }
    if (turn === step.maxTurns) {
      throw new PermanentOperationError("Agent requested a tool on its final permitted turn", "AGENT_TURN_LIMIT_EXHAUSTED");
    }
    const call = response.toolCalls[0]!;
    const toolKey = `${step.key}:tool:${turn}`;
    let toolOutput = await recorder?.lookupTool(toolKey) ?? null;
    if (!toolOutput) {
      const result = await harness.executeToolOperation({
        call, allowedTools: step.allowedTools!,
        context: { runId: evidence.config.trialId, logicalOperationId: toolKey, attemptId: randomUUID(), deadlineAt: new Date(Date.now() + 60_000) },
      });
      toolOutput = { result: result.output as unknown };
      if (recorder) await recorder.storeTool(toolKey, toolOutput);
    }
    messages.push({ role: "assistant", content: response.text, toolCalls: [call] });
    messages.push({ role: "tool", content: JSON.stringify(toolOutput.result), toolCallId: call.id, name: call.name });
  }
  throw new PermanentOperationError("Agent turn budget was exhausted", "AGENT_TURN_LIMIT_EXHAUSTED");
}
