import type { FaultAction, FaultEvent, FaultHookPoint, FaultSpec } from "./types.js";

export class InjectedFault extends Error {
  constructor(
    readonly action: FaultAction,
    readonly faultId: string,
  ) {
    super(`Injected ${action} fault: ${faultId}`);
  }
}

export class DeterministicFaultController {
  readonly events: FaultEvent[] = [];
  readonly #hits = new Map<string, number>();
  readonly #fires = new Map<string, number>();

  constructor(private readonly faults: readonly FaultSpec[]) {}

  hit(hook: FaultHookPoint, operationId: string, elapsedMs: number): void {
    const hitKey = `${hook}:${operationId}`;
    const occurrence = (this.#hits.get(hitKey) ?? 0) + 1;
    this.#hits.set(hitKey, occurrence);

    for (const fault of this.faults) {
      if (fault.hook !== hook || fault.operationId !== operationId) continue;
      const fireCount = this.#fires.get(fault.id) ?? 0;
      const repeat = fault.repeat ?? 1;
      const shouldFire = occurrence >= fault.occurrence && occurrence < fault.occurrence + repeat;
      if (!shouldFire || fireCount >= repeat) continue;
      this.#fires.set(fault.id, fireCount + 1);
      this.events.push({
        faultId: fault.id,
        hook,
        action: fault.action,
        operationId,
        occurrence,
        elapsedMs,
      });
      throw new InjectedFault(fault.action, fault.id);
    }
  }
}
