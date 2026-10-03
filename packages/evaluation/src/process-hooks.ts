import {
  AttemptTimeoutError,
  PermanentOperationError,
  RetryableOperationError,
  type ClaimedOperation,
  type ExecutionFaultBoundary,
  type ExecutionFaultHooks,
} from "@agentflow/runtime";
import { z } from "zod";
import { DeterministicFaultController, InjectedFault } from "./faults.js";
import { faultActions, type FaultSpec } from "./types.js";

const runtimeFaultHookPoints = [
  "before-operation",
  "after-provider-response",
  "after-receiver-commit",
  "before-checkpoint-commit",
  "after-checkpoint-commit",
] as const;

const faultSpecSchema = z.object({
  id: z.string().min(1).max(200),
  hook: z.enum(runtimeFaultHookPoints),
  action: z.enum(faultActions),
  operationId: z.string().min(1).max(200),
  occurrence: z.number().int().positive(),
  repeat: z.number().int().positive().optional(),
});

export function parseFaultPlan(value: string): FaultSpec[] {
  return z.array(faultSpecSchema).parse(JSON.parse(value)).map((fault) => ({
    id: fault.id,
    hook: fault.hook,
    action: fault.action,
    operationId: fault.operationId,
    occurrence: fault.occurrence,
    ...(fault.repeat === undefined ? {} : { repeat: fault.repeat }),
  }));
}

export function createProcessFaultHooks(
  faults: readonly FaultSpec[],
  options: {
    now?: () => number;
    terminate?: () => never;
  } = {},
): ExecutionFaultHooks {
  const controller = new DeterministicFaultController(faults);
  const startedAt = (options.now ?? Date.now)();
  const terminate = options.terminate ?? (() => {
    process.kill(process.pid, "SIGKILL");
    throw new Error("SIGKILL did not terminate the worker");
  });
  return {
    hit(boundary: ExecutionFaultBoundary, operation: ClaimedOperation): void {
      if (boundary === "completion-start") return;
      try {
        controller.hit(boundary, operation.nodeKey, (options.now ?? Date.now)() - startedAt);
      } catch (error) {
        if (!(error instanceof InjectedFault)) throw error;
        if (error.action === "crash") terminate();
        if (error.action === "timeout") throw new AttemptTimeoutError(error.message);
        if (error.action === "permanent-error") {
          throw new PermanentOperationError(error.message, "INJECTED_PERMANENT_ERROR");
        }
        throw new RetryableOperationError(error.message, "INJECTED_TRANSIENT_ERROR");
      }
    },
  };
}
