import { describe, expect, it } from "vitest";
import { ProviderRegistry, type LLMProvider } from "@agentflow/harness";
import { advertisedProviders, startHeartbeat } from "../../apps/worker/src/heartbeat.ts";
import type { AdvertisedProvider } from "../../packages/runtime/src/index.ts";

function provider(name: string): LLMProvider {
  return {
    name,
    adapterVersion: "1",
    capabilities: {} as LLMProvider["capabilities"],
    execute: () => Promise.reject(new Error("not used")),
  };
}

/** A manual interval scheduler so ticks are explicit. */
function manualTimers() {
  const callbacks = new Map<number, () => void>();
  let next = 1;
  return {
    setInterval: ((callback: () => void) => {
      const id = next++;
      callbacks.set(id, callback);
      return { id, unref() { return this; } } as unknown as NodeJS.Timeout;
    }) as unknown as typeof setInterval,
    clearInterval: ((handle: { id: number }) => { callbacks.delete(handle.id); }) as unknown as typeof clearInterval,
    tick() { for (const callback of callbacks.values()) callback(); },
    active: () => callbacks.size,
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("advertisedProviders", () => {
  it("maps registered providers to names and configured models, defaulting to none", () => {
    const registry = new ProviderRegistry().register(provider("scripted-research")).register(provider("gemini"));
    expect(advertisedProviders(registry, { gemini: ["gemini-3.5-flash"] })).toEqual([
      { name: "scripted-research", models: [] },
      { name: "gemini", models: ["gemini-3.5-flash"] },
    ]);
  });
});

describe("startHeartbeat", () => {
  const providers: AdvertisedProvider[] = [{ name: "gemini", models: ["m"] }];

  it("writes immediately and on every interval", async () => {
    const timers = manualTimers();
    const writes: AdvertisedProvider[][] = [];
    const heartbeat = startHeartbeat({
      providers, intervalMs: 10_000, write: async (p) => { writes.push(p); }, ...timers,
    });
    await heartbeat.ready;
    expect(writes).toHaveLength(1);
    timers.tick();
    timers.tick();
    await flush();
    expect(writes).toEqual([providers, providers, providers]);
    heartbeat.stop();
  });

  it("logs a failed write and keeps beating", async () => {
    const timers = manualTimers();
    const logged: unknown[] = [];
    let calls = 0;
    const heartbeat = startHeartbeat({
      providers,
      write: async () => { calls += 1; if (calls === 1) throw new Error("db blip"); },
      log: (_message, error) => { logged.push(error); },
      ...timers,
    });
    await heartbeat.ready;
    expect((logged[0] as Error).message).toBe("db blip");
    timers.tick();
    await flush();
    expect(calls).toBe(2);
    heartbeat.stop();
  });

  it("stops scheduling writes after stop()", async () => {
    const timers = manualTimers();
    let calls = 0;
    const heartbeat = startHeartbeat({ providers, write: async () => { calls += 1; }, ...timers });
    await heartbeat.ready;
    heartbeat.stop();
    expect(timers.active()).toBe(0);
    timers.tick();
    await flush();
    expect(calls).toBe(1);
  });
});
