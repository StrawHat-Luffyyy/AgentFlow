import { describe, expect, it } from "vitest";
import {
  deadlineMsFromMinutes,
  extractReport,
  parseRunInput,
  readiness,
  referenceTemplate,
  runMode,
  summarizeUsage,
  usageDetail,
  type Availability,
} from "../../apps/web/src/new-run.ts";

describe("parseRunInput", () => {
  it("accepts a JSON object", () => {
    expect(parseRunInput('{ "a": 1 }')).toEqual({ ok: true, value: { a: 1 } });
  });

  it.each(["[]", '"x"', "null", "3"])("rejects non-object %s", (text) => {
    expect(parseRunInput(text)).toEqual({ ok: false, error: "Input must be a JSON object" });
  });

  it("reports the line and column of a syntax error", () => {
    const result = parseRunInput('{\n  "a": 1\n  "b": 2\n}');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/line 3, column 3/);
  });

  it("derives line and column from a bare position", () => {
    const result = parseRunInput('{"a":1,}');
    expect(!result.ok && result.error).toMatch(/line 1, column \d+/);
  });

  it("rejects empty input", () => {
    expect(parseRunInput("   ").ok).toBe(false);
  });
});

describe("referenceTemplate", () => {
  it("produces a valid reference input with a timestamped controlled target", () => {
    const text = referenceTemplate(new Date("2026-10-08T09:05:03Z"));
    const parsed = parseRunInput(text);
    expect(parsed.ok).toBe(true);
    const value = (parsed as { value: Record<string, unknown> }).value;
    expect(value.publicationTarget).toBe("controlled://publications/dashboard-20261008-090503");
    expect(value.assumptions).toEqual({
      scope: "Managed Kubernetes and supporting general-purpose compute",
      geography: "Representative US region; no cross-vendor SKU equivalence asserted",
      pricing: "No live price ranking; validate current SKU, region, storage, and network costs separately",
    });
  });
});

describe("readiness", () => {
  const scriptedOnly: Availability = {
    workers: 1,
    providers: [{ name: "scripted-research", models: ["s"], workerCount: 1 }],
  };
  const withGemini: Availability = {
    workers: 2,
    providers: [
      { name: "gemini", models: ["gemini-3.5-flash"], workerCount: 1 },
      { name: "scripted-research", models: ["s"], workerCount: 2 },
    ],
  };

  it("blocks when a required provider has no online worker", () => {
    const result = readiness(["gemini"], scriptedOnly);
    expect(result).toMatchObject({ state: "block-missing-provider", blocking: true });
    expect(result.message).toContain("GEMINI_API_KEY");
  });

  it("warns without blocking when no workers are online", () => {
    expect(readiness(["gemini"], { workers: 0, providers: [] })).toMatchObject({ state: "warn-no-workers", blocking: false });
  });

  it("does not block when availability is unknown", () => {
    expect(readiness(["gemini"], null)).toMatchObject({ state: "unknown", blocking: false });
  });

  it("is ok when every required provider is online", () => {
    const result = readiness(["gemini"], withGemini);
    expect(result).toMatchObject({ state: "ok", blocking: false });
    expect(result.message).toContain("2 workers online");
  });

  it("is ok for workflows without LLM steps", () => {
    expect(readiness([], scriptedOnly)).toMatchObject({ state: "ok", blocking: false });
  });

  it("uses generic guidance for non-gemini providers", () => {
    const result = readiness(["openai"], withGemini);
    expect(result.blocking).toBe(true);
    expect(result.message).toContain("openai");
    expect(result.message).not.toContain("GEMINI_API_KEY");
  });
});

describe("runMode", () => {
  it("classifies scripted, live and no-LLM runs", () => {
    expect(runMode(["scripted-research"])).toEqual({ kind: "scripted" });
    expect(runMode(["gemini", "scripted-research"])).toEqual({ kind: "live", provider: "gemini" });
    expect(runMode(["gemini"])).toEqual({ kind: "live", provider: "gemini" });
    expect(runMode([])).toEqual({ kind: "none" });
    expect(runMode(undefined)).toEqual({ kind: "none" });
  });
});

describe("extractReport", () => {
  it("finds the last step output carrying a report", () => {
    const steps = [
      { acceptedOutput: { report: { title: "Old", content: "old", citations: [] } } },
      { acceptedOutput: { report: { title: "Cloud comparison", content: "# Body", citations: ["aws-ec2-pricing"] } } },
      { acceptedOutput: { receiptId: "r1" } },
    ];
    expect(extractReport(steps)).toEqual({ title: "Cloud comparison", content: "# Body", citations: ["aws-ec2-pricing"] });
  });

  it("returns null when no step has report content", () => {
    expect(extractReport([{ acceptedOutput: null }, { acceptedOutput: { report: { content: 3 } } }])).toBeNull();
  });

  it("tolerates a missing title and citations", () => {
    expect(extractReport([{ acceptedOutput: { report: { content: "x" } } }])).toEqual({ title: "Report", content: "x", citations: [] });
  });
});

describe("deadlineMsFromMinutes", () => {
  it("converts whole minutes in range", () => {
    expect(deadlineMsFromMinutes("5")).toEqual({ ok: true, value: 300_000 });
    expect(deadlineMsFromMinutes("1440")).toEqual({ ok: true, value: 86_400_000 });
  });

  it.each(["0", "1441", "2.5", "", "abc"])("rejects %j", (text) => {
    expect(deadlineMsFromMinutes(text).ok).toBe(false);
  });
});

describe("summarizeUsage", () => {
  it("returns null when nothing has been recorded", () => {
    expect(summarizeUsage([])).toBeNull();
  });

  it("sums only persisted counts and keeps provenance as reported", () => {
    const summary = summarizeUsage([
      { provider: "gemini", model: "gemini-3.5-flash", provenance: "reported", inputTokens: 100, outputTokens: 40 },
      { provider: "gemini", model: "gemini-3.5-flash", provenance: "reported", inputTokens: 50, outputTokens: 10 },
      { provider: "scripted-research", model: "s", provenance: "estimated", inputTokens: null, outputTokens: null },
    ]);
    expect(summary).toEqual({
      input: 150,
      output: 50,
      groups: [
        { label: "gemini · gemini-3.5-flash", input: 150, output: 50, provenances: ["reported"] },
        { label: "scripted-research · s", input: 0, output: 0, provenances: ["estimated"] },
      ],
    });
  });
});

describe("usageDetail", () => {
  it("says nothing is recorded when there are no records", () => {
    expect(usageDetail(null)).toBe("No usage recorded yet");
  });

  it("shows persisted provenance exactly as returned, never relabelled", () => {
    const summary = summarizeUsage([
      { provider: "gemini", model: "gemini-3.5-flash", provenance: "unknown", inputTokens: null, outputTokens: null },
    ]);
    expect(usageDetail(summary)).toBe("0 in · 0 out · unknown");
  });

  it("lists mixed provenances", () => {
    const summary = summarizeUsage([
      { provider: "gemini", model: "m", provenance: "reported", inputTokens: 1200, outputTokens: 300 },
      { provider: "scripted-research", model: "s", provenance: "estimated", inputTokens: 10, outputTokens: 5 },
    ]);
    expect(usageDetail(summary)).toBe("1,210 in · 305 out · estimated, reported");
  });
});
