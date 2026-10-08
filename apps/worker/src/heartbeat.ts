import type { ProviderRegistry } from "@agentflow/harness";
import type { AdvertisedProvider } from "@agentflow/runtime";

/** The providers this worker can execute, as advertised to the operations UI. */
export function advertisedProviders(
  registry: ProviderRegistry,
  models: Record<string, string[]>,
): AdvertisedProvider[] {
  return registry.list().map((provider) => ({ name: provider.name, models: models[provider.name] ?? [] }));
}

export interface HeartbeatOptions {
  write: (providers: AdvertisedProvider[]) => Promise<void>;
  providers: AdvertisedProvider[];
  intervalMs?: number;
  log?: (message: string, error: unknown) => void;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
}

/**
 * Periodically records advisory readiness. Failures are logged and never thrown:
 * the heartbeat must not affect the worker's ability to process operations.
 */
export function startHeartbeat(options: HeartbeatOptions): { stop(): void; ready: Promise<void> } {
  const schedule = options.setInterval ?? setInterval;
  const cancel = options.clearInterval ?? clearInterval;
  const log = options.log ?? ((message, error) => console.error(message, error));
  const beat = () => options.write(options.providers).catch((error: unknown) => {
    log("Worker heartbeat write failed", error);
  });
  const ready = beat();
  const timer = schedule(() => void beat(), options.intervalMs ?? 10_000);
  timer.unref?.();
  return { stop: () => cancel(timer), ready };
}
