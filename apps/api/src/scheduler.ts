import type { Database } from "@agentflow/db";
import { repairScheduling, type SchedulingRepairResult } from "@agentflow/runtime";

export interface RecoveryScheduler {
  repairOnce(): Promise<SchedulingRepairResult>;
  start(): void;
  stop(): Promise<void>;
}

export function createRecoveryScheduler(
  database: Database,
  pollMs: number,
  dispatchRecoveryMs: number,
): RecoveryScheduler {
  let timer: NodeJS.Timeout | undefined;
  let stopping = false;
  let activeRepair: Promise<SchedulingRepairResult> | undefined;

  async function repairOnce(): Promise<SchedulingRepairResult> {
    return repairScheduling(database, dispatchRecoveryMs);
  }

  async function tick(): Promise<void> {
    if (stopping) return;
    try {
      activeRepair = repairOnce();
      const repaired = await activeRepair;
      if (repaired.expiredLeases || repaired.recoveredDispatches) {
        console.info("Scheduling repair completed", repaired);
      }
    } catch (error) {
      console.error("Scheduling repair failed", error);
    } finally {
      activeRepair = undefined;
    }
    if (!stopping) timer = setTimeout(tick, pollMs);
  }

  return {
    repairOnce,
    start() {
      if (!timer && !stopping) timer = setTimeout(() => void tick(), 0);
    },
    async stop() {
      stopping = true;
      if (timer) clearTimeout(timer);
      await activeRepair?.catch(() => undefined);
    },
  };
}
