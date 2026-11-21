import { createHash } from "node:crypto";
import {
  AgentHarness,
  DeterministicFakeProvider,
  ProviderRegistry,
  ToolRegistry,
  llmJournalKeyVersion,
  type LLMJournalKeyInput,
} from "@agentflow/harness";
import { canonicalJson } from "@agentflow/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";

function toolRegistry(version = "1", description = "Search the fixed corpus") {
  return new ToolRegistry().register({
    name: "search",
    version,
    description,
    effectClass: "PURE",
    providerSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
    inputSchema: z.object({ q: z.string() }),
    outputSchema: z.unknown(),
    execute: () => ({}),
  });
}

class RenamedAdapter extends DeterministicFakeProvider {
  override readonly adapterVersion = "2.0.0";
}

const harness = (tools = toolRegistry(), provider = new DeterministicFakeProvider()) =>
  new AgentHarness(new ProviderRegistry().register(provider), tools);

const base: LLMJournalKeyInput = {
  provider: "fake",
  request: {
    model: "fake-model",
    instructions: "Compare pricing.",
    messages: [{ role: "user", content: "{\"topic\":\"pricing\"}" }],
    maxOutputTokens: 256,
  },
  allowedTools: ["search"],
};

const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");

describe("LLM journal key", () => {
  it("records the provider identity, tool versions and sampling parameters", () => {
    expect(harness().journalKey(base)).toEqual({
      hashVersion: llmJournalKeyVersion,
      provider: "fake",
      adapterVersion: "1.0.0",
      model: "fake-model",
      instructions: "Compare pricing.",
      messages: [{ role: "user", content: "{\"topic\":\"pricing\"}" }],
      tools: [{
        name: "search",
        version: "1",
        description: "Search the fixed corpus",
        inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
      }],
      params: { maxOutputTokens: 256, temperature: null },
      opaqueState: null,
    });
  });

  it("is stable for identical requests regardless of key order", () => {
    const reordered: LLMJournalKeyInput = {
      allowedTools: ["search"],
      request: {
        maxOutputTokens: 256,
        messages: [{ content: "{\"topic\":\"pricing\"}", role: "user" }],
        instructions: "Compare pricing.",
        model: "fake-model",
      },
      provider: "fake",
    };
    expect(digest(harness().journalKey(reordered))).toBe(digest(harness().journalKey(base)));
  });

  it("changes whenever anything that shapes the response changes", () => {
    const reference = digest(harness().journalKey(base));
    const variants = [
      harness().journalKey({ ...base, request: { ...base.request, model: "other-model" } }),
      harness().journalKey({ ...base, request: { ...base.request, temperature: 0 } }),
      harness().journalKey({ ...base, request: { ...base.request, maxOutputTokens: 512 } }),
      harness().journalKey({ ...base, request: { ...base.request, instructions: "Compare features." } }),
      harness().journalKey({ ...base, request: { ...base.request, opaqueState: { cursor: "1" } } }),
      harness().journalKey({ ...base, allowedTools: [] }),
      harness(toolRegistry("2")).journalKey(base),
      harness(toolRegistry("1", "Different description")).journalKey(base),
      harness(toolRegistry(), new RenamedAdapter()).journalKey(base),
    ].map(digest);
    expect(new Set(variants).size).toBe(variants.length);
    expect(variants).not.toContain(reference);
  });
});
