import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { canonicalJson } from "@agentflow/shared";
import type { EvaluationOperation, EvaluationWorkload } from "./types.js";

export interface DbosReferenceInput {
  workloadId: string;
  workloadVersion: string;
  corpusHash: string;
  operations: EvaluationOperation[];
}

export interface DbosReferenceOperationResult {
  operationId: string;
  kind: EvaluationOperation["kind"];
  outputHash: string;
}

export interface DbosReferenceResult {
  system: "DBOS";
  sdkVersion: "5.2.11";
  outputs: DbosReferenceOperationResult[];
}

let crashAfterOperation: string | null = null;
let abruptTerminator: () => never = () => {
  process.kill(process.pid, "SIGKILL");
  throw new Error("SIGKILL did not terminate the process");
};

export function configureDbosReferenceCrash(
  operationId: string | null,
  terminator?: () => never,
): void {
  crashAfterOperation = operationId;
  if (terminator) abruptTerminator = terminator;
}

async function referenceWorkflowFunction(input: DbosReferenceInput): Promise<DbosReferenceResult> {
  const outputs: DbosReferenceOperationResult[] = [];
  for (const operation of input.operations) {
    const output = await DBOS.runStep(async () => {
      const outputHash = createHash("sha256").update(canonicalJson({
        workloadId: input.workloadId,
        corpusHash: input.corpusHash,
        operation,
      })).digest("hex");
      return { operationId: operation.id, kind: operation.kind, outputHash };
    }, { name: operation.id });
    outputs.push(output);
    if (crashAfterOperation === operation.id) {
      console.error(`DBOS_REFERENCE_CRASH operation=${operation.id} boundary=after-step-checkpoint`);
      abruptTerminator();
    }
  }
  return { system: "DBOS", sdkVersion: "5.2.11", outputs };
}

export const dbosReferenceWorkflow = DBOS.registerWorkflow(referenceWorkflowFunction, {
  name: "agentflowEvaluationReference",
});

export function dbosReferenceInput(workload: EvaluationWorkload): DbosReferenceInput {
  return {
    workloadId: workload.id,
    workloadVersion: workload.version,
    corpusHash: workload.corpusHash,
    operations: structuredClone(workload.operations),
  };
}

export async function runDbosReferenceSubset(options: {
  systemDatabaseUrl: string;
  workflowId: string;
  input: DbosReferenceInput;
}): Promise<{
  workflowId: string;
  result: DbosReferenceResult;
  elapsedMs: number;
  steps: Array<{
    functionId: number;
    name: string;
    startedAtEpochMs: number | null;
    completedAtEpochMs: number | null;
  }>;
}> {
  DBOS.setConfig({
    name: "agentflow-evaluation-reference",
    applicationVersion: "0.1.0",
    systemDatabaseUrl: options.systemDatabaseUrl,
    enableOTLP: false,
  });
  const started = performance.now();
  await DBOS.launch();
  try {
    const handle = await DBOS.startWorkflow(dbosReferenceWorkflow, {
      workflowID: options.workflowId,
      workflowIDReusePolicy: "return-existing",
    })(options.input);
    const result = await handle.getResult();
    const steps = await DBOS.listWorkflowSteps(handle.workflowID);
    return {
      workflowId: handle.workflowID,
      result,
      elapsedMs: performance.now() - started,
      steps: (steps ?? []).map((step) => ({
        functionId: step.functionID,
        name: step.name,
        startedAtEpochMs: step.startedAtEpochMs ?? null,
        completedAtEpochMs: step.completedAtEpochMs ?? null,
      })),
    };
  } finally {
    await DBOS.shutdown();
  }
}
