import { cloudComparisonWorkflowDefinition } from "@agentflow/research";
import { canonicalJson, workflowDefinitionSchema } from "@agentflow/shared";
import { describe, expect, it } from "vitest";
import { reuseDetail } from "../../apps/web/src/new-run.js";

describe("workflow cacheScope", () => {
  const steps = [{ key: "only", kind: "DETERMINISTIC", handler: "generate-summary" }];

  it("accepts run, version, and off and rejects anything else", () => {
    for (const cacheScope of ["run", "version", "off"]) {
      expect(workflowDefinitionSchema.parse({ steps, cacheScope }).cacheScope).toBe(cacheScope);
    }
    expect(workflowDefinitionSchema.safeParse({ steps, cacheScope: "global" }).success).toBe(false);
  });

  it("adds nothing to definitions that omit it, so existing version hashes are unchanged", () => {
    const definition = cloudComparisonWorkflowDefinition();
    const parsed = workflowDefinitionSchema.parse(definition);
    expect("cacheScope" in parsed).toBe(false);
    expect(canonicalJson(parsed)).toBe(canonicalJson(workflowDefinitionSchema.parse(JSON.parse(JSON.stringify(definition)))));
  });
});

describe("dashboard reuse lines", () => {
  const base = {
    replayedCalls: 0, savedByReplayInputTokens: 0, savedByReplayOutputTokens: 0,
    cacheHitCalls: 0, savedByCacheInputTokens: 0, savedByCacheOutputTokens: 0,
    cacheScope: "run", cacheLookups: { hits: 0, misses: 0, off: 0 },
  };

  it("shows nothing when nothing was looked up or replayed", () => {
    expect(reuseDetail(base)).toEqual([]);
    expect(reuseDetail(null)).toEqual([]);
  });

  it("keeps journal replay and cache hits on separate lines", () => {
    expect(reuseDetail({
      ...base,
      replayedCalls: 1, savedByReplayInputTokens: 1200, savedByReplayOutputTokens: 300,
      cacheHitCalls: 2, savedByCacheInputTokens: 900, savedByCacheOutputTokens: 80,
      cacheScope: "version", cacheLookups: { hits: 2, misses: 1, off: 0 },
    })).toEqual([
      "Journal replay: 1 call avoided · 1,200 in · 300 out saved",
      "Response cache (version): 2 hits · 1 miss · 900 in · 80 out saved",
    ]);
  });

  it("reports a disabled cache plainly", () => {
    expect(reuseDetail({ ...base, cacheScope: "off", cacheLookups: { hits: 0, misses: 0, off: 3 } }))
      .toEqual(["Response cache: off"]);
  });
});
