import { fork, execFileSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { cpus, totalmem } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { migrate } from "@agentflow/db";
import { TOOL_RESEARCH_STEP, cloudComparisonCorpusHash, toolResearchAnswer, toolResearchCallsPerRun } from "@agentflow/research";
import { modelPriceTableSchema } from "@agentflow/shared";
import { SeededRandom } from "./random.js";
import { quantile, wilsonInterval, pairedBootstrapInterval } from "./statistics.js";
import { Evidence, evidenceDatabase, installEvidenceSchema, isAgentFlowSystem, publicationTarget, digest, realScenarios, realSystems,
  referenceDefinition, e8RejectedCalls, realWorkloads, toolResearchScenarios,
  type RealConfig, type RealProvider, type RealScenario, type RealSystem, type RealWorkload } from "./real-common.js";
import { llmEventMetrics } from "./real-metrics.js";
import { costGuardTripped, projectCampaign, renderProjection } from "./campaign-plan.js";
import { writeTokenReport } from "./token-report.js";

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(name); return index < 0 ? fallback : process.argv[index + 1]!;
}
const seed = Number(argument("--seed", "42"));
const trials = Number(argument("--trials", "1"));
const systems = argument("--systems", "B0,B1,A1").split(",") as RealSystem[];
const scenarios = argument("--scenarios", "E0,E1,E2,E2B,E3,E4,E5,E6,E7").split(",") as RealScenario[];
// LLM response-cache scope for AgentFlow workflow versions (brief §2.2). Empty keeps the
// definition unchanged (runtime default "run"), so earlier campaigns stay comparable.
const cacheScope = argument("--cache-scope", "");
if (!["", "run", "version", "off"].includes(cacheScope)) throw new Error("--cache-scope must be run, version, or off");
// Reference workflow context (brief §2.4). Default "full" keeps prompts identical to the
// cited campaigns; "minimal" gives every system (AgentFlow and baselines) the projected prompts.
const contextArgument = argument("--context", "full");
if (contextArgument !== "full" && contextArgument !== "minimal") throw new Error("--context must be full or minimal");
const context: "full" | "minimal" = contextArgument;
// LLM provider for every system (brief §3.3 / §9). Token counts are only "reported" for live providers.
const providerArgument = argument("--provider", "scripted");
if (!["scripted", "gemini", "groq"].includes(providerArgument)) throw new Error("--provider must be scripted, gemini, or groq");
const provider = providerArgument as RealProvider;
// Live keys and models usually live in .env; children inherit this process's env.
if (provider !== "scripted") {
  try { process.loadEnvFile?.(); } catch { /* .env is optional */ }
  const keyName = provider === "gemini" ? "GEMINI_API_KEY" : "GROQ_API_KEY";
  if (!process.env[keyName] && !process.argv.includes("--dry-run")) throw new Error(`--provider ${provider} needs ${keyName} (env or .env)`);
}
const defaultModel = provider === "gemini" ? (process.env.GEMINI_MODEL || "gemini-3.5-flash")
  : provider === "groq" ? (process.env.GROQ_MODEL || "openai/gpt-oss-120b") : "";
const model = argument("--model", defaultModel);
// Cost guard: a hard campaign-wide ceiling on reported tokens, required for live providers.
const maxCampaignTokensArgument = argument("--max-campaign-tokens", "");
const maxCampaignTokens = maxCampaignTokensArgument === "" ? null : Number(maxCampaignTokensArgument);
const minTrialIntervalMs = Number(argument("--min-trial-interval-ms", "0"));
// Workload (see realWorkloads). tool-research: one agent step, five LLM calls; scripted only.
const workloadArgument = argument("--workload", "cloud-comparison");
if (!(realWorkloads as readonly string[]).includes(workloadArgument)) throw new Error(`--workload must be ${realWorkloads.join(" or ")}`);
const workload = workloadArgument as RealWorkload;
const crashTurn = Number(argument("--crash-turn", "3"));
if (workload === "tool-research") {
  if (provider !== "scripted") throw new Error("--workload tool-research runs on the scripted provider only");
  if (!Number.isInteger(crashTurn) || crashTurn < 1 || crashTurn > toolResearchCallsPerRun) {
    throw new Error(`--crash-turn must be 1..${toolResearchCallsPerRun}`);
  }
  const unsupported = scenarios.filter((s) => !toolResearchScenarios.includes(s));
  if (unsupported.length) throw new Error(`--workload tool-research supports ${toolResearchScenarios.join(", ")} (not ${unsupported.join(", ")})`);
}
const dryRun = process.argv.includes("--dry-run");
if (!Number.isInteger(trials) || trials < 1 || !Number.isInteger(seed) ||
    systems.some((s) => !(realSystems as readonly string[]).includes(s)) ||
    scenarios.some((s) => !(realScenarios as readonly string[]).includes(s))) throw new Error("Invalid experiment configuration");
if (maxCampaignTokens !== null && (!Number.isInteger(maxCampaignTokens) || maxCampaignTokens < 1)) throw new Error("--max-campaign-tokens must be a positive integer");
if (provider !== "scripted" && maxCampaignTokens === null && !dryRun) throw new Error("Live campaigns require --max-campaign-tokens (run --dry-run first)");
// A1-cache measures the version-scoped cache, which only R1 (repeated identical runs) isolates;
// in fault scenarios it would answer every later trial from cache and hide recovery behaviour.
if (systems.includes("A1-cache") && scenarios.some((s) => s !== "R1")) throw new Error("A1-cache is only valid in scenario R1");
if (scenarios.includes("R1") && context !== "minimal") throw new Error("R1 requires --context minimal (full prompts differ per run)");
if (dryRun) {
  const prices = modelPriceTableSchema.parse(JSON.parse(process.env.AGENTFLOW_MODEL_PRICES || "{}"));
  const definitionProvider = provider === "scripted" ? "scripted-research" : provider;
  const price = prices[`${definitionProvider}/${provider === "scripted" ? "cloud-comparison-scripted-v1" : model}`] ?? null;
  const tokensPerCall = Number(argument("--tokens-per-call", provider === "scripted" ? "360" : "2000"));
  const shape = { systems, scenarios, trials, tokensPerCall, e8RejectedCalls,
    ...(workload === "tool-research" ? { callsPerRun: toolResearchCallsPerRun } : {}) };
  console.log(renderProjection(shape, projectCampaign(shape, price), `${provider}${model ? ` ${model}` : ""}, context ${context}`));
  if (maxCampaignTokens !== null) console.log(`Cost guard: the campaign stops before the next trial once ${maxCampaignTokens} reported tokens are spent.`);
  process.exit(0);
}
const campaign = `real-${Date.now()}-${randomUUID().slice(0, 8)}`;
const output = resolve(argument("--output", `evaluation-results/${campaign}`));
const isDemo = scenarios.includes("DEMO");
const defaultPort = isDemo ? "3000" : "0";
const apiPort = Number(process.env.AGENTFLOW_API_PORT || argument("--api-port", defaultPort));
const token = process.env.AGENTFLOW_DEMO_TOKEN || argument("--token", "") || (isDemo ? "agentflow-demo-token-12345678901234567890123456789012" : randomBytes(32).toString("hex"));
const isInteractive = isDemo && argument("--non-interactive", "") === "";
const interactiveTimeoutMs = Number(argument("--approval-timeout-ms", "120000"));
const approvalDelayMs = Number(argument("--approval-delay-ms", isDemo ? "6000" : "0"));
const defaultDelayMs = isDemo ? "500" : "0";
const keepAlive = isDemo ? argument("--no-keep-alive", "") === "" : (argument("--keep-alive", "") !== "" || process.env.AGENTFLOW_KEEP_ALIVE === "true");
const base: RealConfig = {
  trialId: campaign, system: "A1", scenario: "E0",
  databaseUrl: process.env.EVALUATION_DATABASE_URL ?? "postgresql://agentflow:agentflow@localhost:5432/agentflow_acceptance_eval",
  dbosUrl: process.env.DBOS_SYSTEM_DATABASE_URL ?? "postgresql://agentflow:agentflow@localhost:5432/agentflow_reference_eval",
  redisUrl: process.env.EVALUATION_REDIS_URL ?? "redis://localhost:6379", queue: `agentflow-${campaign}`,
  leaseMs: Number(argument("--lease-ms", "1000")), retryMs: 20,
  operationDelayMs: Number(argument("--operation-delay-ms", defaultDelayMs)), observationMs: Number(argument("--observation-ms", isDemo ? "600000" : "120000")),
  apiPort, context, provider, ...(model ? { model } : {}),
  ...(workload === "tool-research" ? { workload, crashTurn } : {}),
};
if (!new URL(base.dbosUrl).pathname.endsWith("_eval")) throw new Error("DBOS database must end in _eval");
await mkdir(output, { recursive: true });
const db = evidenceDatabase(base.databaseUrl);
await migrate(db); await installEvidenceSchema(db);
const credentials = JSON.stringify([{ id: "acceptance-owner", tokenHash: createHash("sha256").update(token).digest("hex"), roles: ["research-reviewer", "operator"] }]);
const demoAdminPassword = process.env.AGENTFLOW_ADMIN_PASSWORD || (isDemo ? "demo-operator-2026" : undefined);
const children = new Set<ChildProcess>();
const logs: string[] = [];
async function launch(role: string, config: RealConfig): Promise<{ child: ChildProcess; port?: number }> {
  const child = fork(fileURLToPath(new URL("./real-child.ts", import.meta.url)), [role], {
    execArgv: ["--import", "tsx"], windowsHide: true, silent: true,
    env: {
      ...process.env,
      AGENTFLOW_EVALUATION_CONFIG: JSON.stringify(config),
      AGENTFLOW_AUTH_CREDENTIALS: credentials,
      ...(demoAdminPassword ? { AGENTFLOW_ADMIN_PASSWORD: demoAdminPassword } : {}),
    },
  });
  children.add(child);
  child.on("exit", () => children.delete(child));
  for (const stream of [child.stdout, child.stderr]) stream?.on("data", (chunk: Buffer) => {
    logs.push(`${config.trialId} ${role} ${chunk.toString()}`);
  });
  return new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error(`${role} startup timed out`)), 30_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`${role} exited during startup: ${code}`)); });
    child.on("message", (message: { ready?: boolean; port?: number }) => {
      if (message.ready) { clearTimeout(timer); resolveReady({ child, ...(message.port ? { port: message.port } : {}) }); }
    });
  });
}
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveExit) => { child.once("exit", () => resolveExit()); child.kill("SIGKILL"); });
}
let api = await launch("api", base);
if (isDemo) {
  console.log(`\n======================================================`);
  console.log(`  AgentFlow Real Acceptance DEMO Supervisor Started   `);
  console.log(`======================================================`);
  console.log(`  API Endpoint:   http://127.0.0.1:${api.port}`);
  console.log(`  Operations UI:  http://localhost:4173`);
  console.log(`  Username:       admin`);
  console.log(`  Password:       ${demoAdminPassword}`);
  console.log(`  Access Token:   ${token}`);
  console.log(`  Lease Duration: ${base.leaseMs}ms`);
  console.log(`======================================================\n`);
}
async function request(path: string, body?: unknown): Promise<any> {
  const response = await fetch(`http://127.0.0.1:${api.port}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json();
}
const versions = new Map<string, string>();
async function versionFor(config: RealConfig): Promise<string> {
  const variant = config.system === "A1-nojournal" ? "nojournal" : config.system === "A1-cache" ? "cache" : "standard";
  const key = `${config.scenario === "E6" && config.system !== "A0" ? "unsafe" : "supported"}-${variant}`;
  if (versions.has(key)) return versions.get(key)!;
  const workflow = await request("/workflows", { name: `${campaign}-${key}` });
  const definition = referenceDefinition(config);
  // Ablations: no-journal also turns the cache off (it could otherwise stand in for the
  // journal); A1-cache shares responses across runs of this version (R1 only).
  const scope = variant === "nojournal" ? "off" : variant === "cache" ? "version" : cacheScope;
  if (scope) Object.assign(definition, { cacheScope: scope });
  if (key === "unsafe") {
    const publication = definition.steps.at(-1)!;
    if (publication.kind === "TOOL") publication.effectClass = "UNSAFE_WRITE";
  }
  const version = await request(`/workflows/${workflow.id}/versions`, { version: 1, definition });
  versions.set(key, version.id); return version.id;
}

interface Event { sequence: string; event: string; operation: string | null; pid: number; at: Date; detail: Record<string, any> }
interface Measurement {
  trialId: string; pair: string; system: RealSystem; scenario: RealScenario; outcome: string;
  elapsedMs: number; restarts: number; repeatedOperations: number; reexecutedCommittedOperations: number;
  llmCalls: number; repeatedLlmCalls: number; inputTokens: number; outputTokens: number;
  /** Provenances actually seen in provider results (e.g. ["reported"] or ["estimated"]). */
  usageProvenance: string[];
  provider: RealProvider; resolvedModels: string[];
  /** Input + output tokens of every provider result in the run, and those beyond the first per operation. */
  billedTokens: number; repeatedTokens: number;
  providerErrors: number; rateLimitedCalls: number;
  /** Provider calls avoided by LLM-journal replay, and the tokens those calls had cost (0 for systems without a journal). */
  journalReplays: number; tokensSavedByReplay: number;
  /** Response-cache hits (identical earlier request) and the tokens they avoided; separate from journal replay. */
  cacheHits: number; tokensSavedByCache: number;
  receiverEffects: number; duplicateEffects: number; missingEffects: number; invalidApprovalExecutions: number;
  checkpointBytes: number | null; checkpointMs: number[]; recoveryMs: number[]; correctReport: boolean;
  faultCount: number; error: string | null;
}
const results: Measurement[] = [];
async function trial(system: RealSystem, scenario: RealScenario, index: number): Promise<void> {
  const config: RealConfig = { ...base, system, scenario, trialId: `${campaign}-${scenario}-${index}-${system}` };
  const evidence = new Evidence(db, config);
  await db.query("INSERT INTO evaluation_trials(id,system,scenario) VALUES($1,$2,$3)", [config.trialId, system, scenario]);
  const durable = isAgentFlowSystem(system);
  if (durable) {
    const run = await request("/runs", { workflowVersionId: await versionFor(config),
      creationKey: config.trialId, input: { publicationTarget: publicationTarget(config.trialId) },
      deadlineMs: base.observationMs, retryPolicy: { maxAttempts: 3, initialBackoffMs: base.retryMs, multiplier: 2, maxBackoffMs: base.retryMs * 4 },
    });
    config.runId = run.id;
    await db.query("UPDATE evaluation_trials SET run_id=$2 WHERE id=$1", [config.trialId, run.id]);
    if (isDemo) {
      console.log(`[DEMO] Workflow Run Created: ${run.id}`);
      console.log(`[DEMO] Direct Dashboard Link: http://localhost:4173/runs/${run.id}`);
    }
  }
  const started = Date.now();
  await evidence.event("observation-start");
  let process = (await launch(durable ? "worker" : "baseline", config)).child;
  let restarts = 0;
  let approvalRestarted = false;
  let approved = false;
  let outcome = "CENSORED";
  let error: string | null = null;
  try {
    while (Date.now() - started < config.observationMs) {
      let approval: any;
      if (durable) {
        const run = await request(`/runs/${config.runId}`);
        if (run.lifecycle !== "OPEN" || run.waitReason === "RECONCILIATION") {
          outcome = run.waitReason === "RECONCILIATION" ? "UNKNOWN" : run.lifecycle; break;
        }
        if (run.waitReason === "APPROVAL") approval = (await request(`/runs/${config.runId}/approvals`)).approvals.find((a: any) => a.status === "PENDING");
      } else {
        const state = await db.query("SELECT outcome,error FROM evaluation_trials WHERE id=$1", [config.trialId]);
        if (state.rows[0].outcome) { outcome = state.rows[0].outcome; error = state.rows[0].error; break; }
        const waiting = await db.query("SELECT detail FROM evaluation_events WHERE trial_id=$1 AND event='approval-waiting' ORDER BY sequence DESC LIMIT 1", [config.trialId]);
        if (waiting.rows[0]) approval = waiting.rows[0].detail;
      }
      if (process.exitCode !== null || process.signalCode !== null) {
        if (++restarts > 3) { outcome = "FAILED"; error = "Restart budget exhausted"; break; }
        if (isDemo) console.log(`[DEMO] Worker crash detected. Supervisor spawning replacement worker (restart #${restarts})...`);
        await evidence.event("supervisor-restart");
        process = (await launch(durable ? "worker" : "baseline", config)).child;
      }
      if (approval && !approved) {
        if (["E7", "DEMO"].includes(scenario) && !approvalRestarted) {
          await evidence.event("pending-approval-before-restart", "approve-publication", { id: approval.id ?? null, payloadHash: approval.payloadHash });
          if (isDemo) console.log(`[DEMO] Approval pending. Simulating abrupt API and Worker termination...`);
          await stop(process); await stop(api.child);
          await delay(200);
          api = await launch("api", base);
          process = (await launch(durable ? "worker" : "baseline", config)).child;
          approvalRestarted = true; restarts++;
          if (durable) {
            const pending = (await request(`/runs/${config.runId}/approvals`)).approvals.find((a: any) => a.id === approval.id);
            if (pending?.status !== "PENDING" || pending.payloadHash !== approval.payloadHash) throw new Error("Pending approval changed across restart");
          }
          await evidence.event("pending-approval-after-restart", "approve-publication", { payloadHash: approval.payloadHash });
          if (isDemo) {
            console.log(`[DEMO] Both API and Worker restarted. Approval preserved with hash: ${approval.payloadHash.slice(0, 16)}...`);
            console.log(`[DEMO] Workflow is in WAITING_APPROVAL state.`);
            console.log(`[DEMO] Review proposal & approve live in dashboard: http://localhost:4173/runs/${config.runId}`);
          }
        }
        let userApproved = false;
        if (isInteractive && durable) {
          console.log(`[DEMO] Waiting for dashboard approval at http://localhost:4173/runs/${config.runId} (timeout in ${Math.round(interactiveTimeoutMs / 1000)}s)...`);
          const waitStart = Date.now();
          while (Date.now() - waitStart < interactiveTimeoutMs) {
            const approvalsList = (await request(`/runs/${config.runId}/approvals`)).approvals;
            const current = approvalsList.find((a: any) => a.id === approval.id);
            if (current && current.status === "APPROVED") {
              userApproved = true;
              console.log(`[DEMO] Approval received from Dashboard UI!`);
              break;
            }
            await delay(400);
          }
          if (!userApproved) {
            console.log(`[DEMO] Interactive timeout elapsed without dashboard action; proceeding with supervisor approval fallback...`);
          }
        } else if (isDemo && approvalDelayMs > 0) {
          console.log(`[DEMO] Pausing ${approvalDelayMs / 1000}s for UI review...`);
          await delay(approvalDelayMs);
        }

        await evidence.event("approval-decision", "approve-publication", { payloadHash: approval.payloadHash });
        await db.query("UPDATE evaluation_trials SET approved_hash=$2 WHERE id=$1", [config.trialId, approval.payloadHash]);
        if (durable) {
          if (userApproved) {
            const row = (await db.query<{ decision_request_id: string }>("SELECT decision_request_id FROM approvals WHERE id=$1", [approval.id])).rows[0];
            const replayDecision = { decisionRequestId: row?.decision_request_id, decision: "APPROVE", proposalHash: approval.proposalHash, payloadHash: approval.payloadHash };
            const replayResult = await request(`/approvals/${approval.id}/decisions`, replayDecision);
            if (!replayResult.replayed) throw new Error("Approval request deduplication failed");
            await evidence.event("duplicate-approval-verified", "approve-publication");
            if (isDemo) console.log(`[DEMO] Duplicate approval decision verified idempotent.`);
          } else {
            const decision = { decisionRequestId: randomUUID(), decision: "APPROVE", proposalHash: approval.proposalHash, payloadHash: approval.payloadHash };
            const first = await request(`/approvals/${approval.id}/decisions`, decision);
            const second = await request(`/approvals/${approval.id}/decisions`, decision);
            if (first.replayed || !second.replayed) throw new Error("Approval request deduplication failed");
            await evidence.event("duplicate-approval-verified", "approve-publication");
            if (isDemo) console.log(`[DEMO] Approval submitted and duplicate decision verified idempotent.`);
          }
        }
        approved = true;
      }
      await delay(20);
    }
  } catch (cause) { outcome = "FAILED"; error = String(cause); }
  finally { await stop(process); }
  const elapsedMs = Date.now() - started;
  if (outcome === "CENSORED" && durable) await request(`/runs/${config.runId}/cancel`, {});
  await db.query("UPDATE evaluation_trials SET outcome=$2,error=$3,finished_at=clock_timestamp() WHERE id=$1", [config.trialId, outcome, error]);
  const events = (await db.query<Event>("SELECT * FROM evaluation_events WHERE trial_id=$1 ORDER BY sequence", [config.trialId])).rows;
  const effects = (await db.query("SELECT * FROM controlled_publication_effects WHERE payload_json->'publication'->>'target'=$1 ORDER BY created_at", [publicationTarget(config.trialId)])).rows;
  const state = (await db.query("SELECT approved_hash FROM evaluation_trials WHERE id=$1", [config.trialId])).rows[0];
  const starts = events.filter((e) => e.event === "before-operation");
  const llm = llmEventMetrics(events);
  const committed = new Set<string>(); let reexecuted = 0;
  for (const event of events) {
    if (event.event === "before-operation" && committed.has(event.operation!)) reexecuted++;
    if (event.event === "after-checkpoint-commit" || event.event === "reference-checkpoint") committed.add(event.operation!);
  }
  const crashEvents = events.filter((e) => e.event === "fault" && e.detail.action === "crash");
  const recoveryMs = crashEvents.flatMap((crash) => {
    const resumed = events.find((e) => e.event === "before-operation" && BigInt(e.sequence) > BigInt(crash.sequence));
    return resumed ? [resumed.at.getTime() - crash.at.getTime()] : [];
  });
  let checkpointBytes: number | null = null;
  let runtimeEvidence: unknown = null;
  if (durable) {
    const bytes = await db.query("SELECT COALESCE(sum(pg_column_size(snapshot_json)),0)::integer AS bytes FROM checkpoints WHERE run_id=$1", [config.runId]);
    checkpointBytes = bytes.rows[0].bytes;
    runtimeEvidence = { run: await request(`/runs/${config.runId}`), attempts: await request(`/runs/${config.runId}/attempts`),
      approvals: await request(`/runs/${config.runId}/approvals`), history: await request(`/runs/${config.runId}/history`),
      usage: await request(`/runs/${config.runId}/usage`), toolExecutions: await request(`/runs/${config.runId}/tool-executions`) };
  }
  const usageSummary = (runtimeEvidence as { usage?: { summary?: {
    replayedCalls: number; savedByReplayInputTokens: number; savedByReplayOutputTokens: number;
    cacheHitCalls?: number; savedByCacheInputTokens?: number; savedByCacheOutputTokens?: number;
  } } } | null)?.usage?.summary;
  const measurement: Measurement = {
    trialId: config.trialId, pair: `${scenario}-${index}`, system, scenario, outcome, elapsedMs, restarts,
    repeatedOperations: starts.length - new Set(starts.map((e) => e.operation)).size,
    reexecutedCommittedOperations: reexecuted,
    llmCalls: llm.llmCalls, repeatedLlmCalls: llm.repeatedLlmCalls,
    inputTokens: llm.inputTokens, outputTokens: llm.outputTokens, usageProvenance: llm.usageProvenance,
    provider, resolvedModels: llm.resolvedModels, billedTokens: llm.billedTokens, repeatedTokens: llm.repeatedTokens,
    providerErrors: llm.providerErrors, rateLimitedCalls: llm.rateLimitedCalls,
    journalReplays: usageSummary?.replayedCalls ?? 0,
    tokensSavedByReplay: (usageSummary?.savedByReplayInputTokens ?? 0) + (usageSummary?.savedByReplayOutputTokens ?? 0),
    cacheHits: usageSummary?.cacheHitCalls ?? 0,
    tokensSavedByCache: (usageSummary?.savedByCacheInputTokens ?? 0) + (usageSummary?.savedByCacheOutputTokens ?? 0),
    receiverEffects: effects.length, duplicateEffects: Math.max(0,effects.length-1),
    missingEffects: state.approved_hash && effects.length === 0 ? 1 : 0,
    invalidApprovalExecutions: effects.filter((e) => !state.approved_hash || e.request_hash !== state.approved_hash).length,
    checkpointBytes, checkpointMs: events.filter((e) => e.event === "after-checkpoint-commit").map((e) => e.detail.checkpointMs as number),
    recoveryMs, correctReport: workload === "tool-research"
      // No report is published: the run is correct when it succeeded and its final call returned the scripted answer.
      ? outcome === "SUCCEEDED" && events.some((e) => e.event === "provider-result" && e.operation === TOOL_RESEARCH_STEP &&
        e.detail.turn === toolResearchCallsPerRun && e.detail.outputHash === digest(toolResearchAnswer))
      : effects.some((e) => e.payload_json.report?.citations?.length === 6 &&
        createHash("sha256").update(e.payload_json.report.content).digest("hex") === e.payload_json.report.sha256),
    faultCount: events.filter((e) => e.event === "fault").length, error,
  };
  results.push(measurement);
  await appendFile(join(output,"results.jsonl"), `${JSON.stringify(measurement)}\n`);
  await appendFile(join(output,"evidence.jsonl"), `${JSON.stringify({ trialId: config.trialId, events, effects, runtimeEvidence })}\n`);
  await appendFile(join(output,"process.log"), logs.splice(0).join(""));
  console.log(JSON.stringify({ trial: results.length, system, scenario, outcome, duplicates: measurement.duplicateEffects, elapsedMs, error }));
}

let revision = "unknown";
try { revision = execFileSync("git", ["rev-parse","HEAD"], { encoding: "utf8" }).trim(); } catch {}
const sampling = referenceDefinition(base).steps.find((step) => step.kind === "AGENT");
const manifest = { campaign, seed, trials, systems, scenarios, workload,
  ...(workload === "tool-research" ? { callsPerRun: toolResearchCallsPerRun, crashTurn } : {}),
  cacheScope: workload === "tool-research" ? "off (workload definition)" : cacheScope || "default (run)", context,
  provider, model: model || (workload === "tool-research" ? "tool-research-scripted-v1" : "cloud-comparison-scripted-v1"),
  sampling: sampling?.kind === "AGENT" ? { temperature: sampling.temperature ?? null, seed: sampling.seed ?? null } : null,
  costGuard: { maxCampaignTokens, minTrialIntervalMs }, sourceRevision: revision, sourceDiffHash: digest(execFileSync("git",["diff"],{encoding:"utf8"})),
  node: process.version, hardware: { cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem() },
  corpusHash: cloudComparisonCorpusHash, dbosVersion: "5.2.11", policy: { leaseMs: base.leaseMs, schedulerPollMs: 50, outboxPollMs: 20,
    retryInitialMs: base.retryMs, maxAttempts: 3, maxRestarts: 3, observationMs: base.observationMs, workerConcurrency: 1, operationDelayMs: base.operationDelayMs },
  method: `real processes; PostgreSQL; BullMQ; shared deterministic corpus; ${provider === "scripted" ? "scripted provider" : `live ${provider} provider`}; independent receiver transaction`,
  limitations: [provider === "scripted" ? "Scripted provider token counts are estimates, not billed tokens" : "Live provider output is nondeterministic even at temperature 0 with a seed", "Instrumentation overhead is included",
    "DBOS, C1 (Temporal-style) and C2 (LangGraph-style) are matched reimplementations of a common subset, not tuned by their maintainers", "Serial trials include process startup", "DBOS common subset uses durable steps and an external approval service", "No production checkpoint grouping is changed", "Receiver shares PostgreSQL with the runtime but commits independently"] };
await writeFile(join(output,"manifest.json"), JSON.stringify({ ...manifest, manifestHash: digest(manifest) },null,2));
let spentTokens = 0;
let stoppedByCostGuard = false;
try {
  const random = new SeededRandom(seed);
  campaignLoop: for (const scenario of scenarios) for (let index=0; index<trials; index++) {
    for (const system of random.shuffle(systems)) {
      if (costGuardTripped(spentTokens, maxCampaignTokens)) { stoppedByCostGuard = true; break campaignLoop; }
      if (results.length > 0 && minTrialIntervalMs > 0) await delay(minTrialIntervalMs);
      await trial(system,scenario,index);
      spentTokens += results.at(-1)?.billedTokens ?? 0;
    }
  }
} finally {
  if (stoppedByCostGuard) console.log(`Cost guard: stopped after ${spentTokens} tokens (limit ${maxCampaignTokens}).`);
  await writeFile(join(output,"manifest.json"), JSON.stringify({ ...manifest, manifestHash: digest(manifest), spentTokens, stoppedByCostGuard },null,2));
  // Write aggregate artifacts before an optional keep-alive wait so DEMO evidence is complete.
  const groups = systems.flatMap((system) => scenarios.map((scenario) => {
    const group = results.filter((r) => r.system===system && r.scenario===scenario);
    return { system,scenario,trials:group.length,completion:wilsonInterval(group.filter((r)=>r.outcome==="SUCCEEDED").length,group.length),
      duplicateFree:wilsonInterval(group.filter((r)=>r.duplicateEffects===0).length,group.length),
      medianElapsedMs:quantile(group.map((r)=>r.elapsedMs),0.5),p95ElapsedMs:quantile(group.map((r)=>r.elapsedMs),0.95),
      p95RecoveryMs:quantile(group.flatMap((r)=>r.recoveryMs),0.95),p95CheckpointMs:quantile(group.flatMap((r)=>r.checkpointMs),0.95),
      repeatedLlmCalls:group.reduce((s,r)=>s+r.repeatedLlmCalls,0),
      journalReplays:group.reduce((s,r)=>s+r.journalReplays,0),tokensSavedByReplay:group.reduce((s,r)=>s+r.tokensSavedByReplay,0),
      cacheHits:group.reduce((s,r)=>s+r.cacheHits,0),tokensSavedByCache:group.reduce((s,r)=>s+r.tokensSavedByCache,0),duplicates:group.reduce((s,r)=>s+r.duplicateEffects,0),
      invalidApprovals:group.reduce((s,r)=>s+r.invalidApprovalExecutions,0),committedReexecutions:group.reduce((s,r)=>s+r.reexecutedCommittedOperations,0),
      outcomes:Object.fromEntries([...new Set(group.map((r)=>r.outcome))].map((outcome)=>[outcome,group.filter((r)=>r.outcome===outcome).length])) };
  }));
  const comparisons = scenarios.flatMap((scenario) => systems.filter((s)=>s!=="A1").map((system)=> {
    const treatment = new Map(results.filter((r)=>r.system==="A1"&&r.scenario===scenario).map((r)=>[r.pair,r]));
    const pairs = results.filter((r)=>r.system===system&&r.scenario===scenario&&treatment.has(r.pair));
    return {scenario,baseline:system,pairs:pairs.length,
      elapsedDifference:pairedBootstrapInterval(pairs.map((r)=>({baseline:r.elapsedMs,treatment:treatment.get(r.pair)!.elapsedMs})),seed),
      repeatedCallsDifference:pairedBootstrapInterval(pairs.map((r)=>({baseline:r.repeatedLlmCalls,treatment:treatment.get(r.pair)!.repeatedLlmCalls})),seed)};
  }));
  await writeFile(join(output,"summary.json"),JSON.stringify({groups,comparisons},null,2));
  if (results.length) {
    await writeFile(join(output,"results.jsonl"), results.map((r) => JSON.stringify(r)).join("\n") + "\n");
    for (const headline of await writeTokenReport(output)) console.log(headline);
  }
  if (results.length) {
    const columns=Object.keys(results[0]!) as Array<keyof Measurement>;
    const csv=(value: unknown)=>`"${String(typeof value === "object" ? JSON.stringify(value) : value).replaceAll('"','""')}"`;
    await writeFile(join(output,"results.csv"),[columns.join(","),...results.map((r)=>columns.map((c)=>csv(r[c])).join(","))].join("\n")+"\n");
  }
  if (keepAlive) {
    console.log(`\n======================================================`);
    const succeeded = results.length > 0 && results.every((r) => r.outcome === "SUCCEEDED");
    console.log(succeeded ? `  AgentFlow DEMO Completed Successfully!             ` : `  AgentFlow DEMO finished with outcome: ${results.map((r) => r.outcome).join(", ") || "NONE"}`);
    console.log(`======================================================`);
    console.log(`  API Server kept alive at: http://127.0.0.1:${api.port}`);
    console.log(`  Explore dashboard at:     http://localhost:4173`);
    console.log(`  Press Ctrl+C when finished recording.`);
    console.log(`======================================================\n`);
    await new Promise(() => {});
  }
  await Promise.all([...children].map(stop));
  await db.end();
}
console.log(`Evidence: ${output}`);
