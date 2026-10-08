import { describe, expect, it } from "vitest";
import { stripVTControlCharacters } from "node:util";
import { UsageError } from "../../apps/cli/src/errors.js";
import { formatRelative, parseDuration } from "../../apps/cli/src/output/duration.js";
import { colorEnabled, paintStatus } from "../../apps/cli/src/output/style.js";
import { renderTable } from "../../apps/cli/src/output/table.js";
import { run } from "../../apps/cli/src/run.js";
import { fakeIO } from "./cli-helpers.js";

const NOW = Date.parse("2026-10-08T12:00:00.000Z");

describe("parseDuration", () => {
  it.each([
    ["500ms", 500],
    ["90s", 90_000],
    ["5m", 300_000],
    ["1h", 3_600_000],
    ["2d", 172_800_000],
  ])("parses %s", (text, ms) => {
    expect(parseDuration(text)).toBe(ms);
  });

  it.each(["5", "5x", "", "-1s"])("rejects %j as a usage error", (text) => {
    expect(() => parseDuration(text)).toThrow(UsageError);
  });
});

describe("formatRelative", () => {
  it("formats past and future offsets", () => {
    expect(formatRelative(new Date(NOW - 5_000), NOW)).toBe("just now");
    expect(formatRelative(new Date(NOW - 42_000), NOW)).toBe("42s ago");
    expect(formatRelative(new Date(NOW - 180_000), NOW)).toBe("3m ago");
    expect(formatRelative(new Date(NOW - 7_200_000), NOW)).toBe("2h ago");
    expect(formatRelative(new Date(NOW - 5 * 86_400_000).toISOString(), NOW)).toBe("5d ago");
    expect(formatRelative(new Date(NOW + 180_000), NOW)).toBe("in 3m");
  });
});

describe("colorEnabled", () => {
  it("is off for non-TTY stdout", () => {
    expect(colorEnabled(fakeIO().io, true)).toBe(false);
  });
  it("is off with NO_COLOR on a TTY", () => {
    expect(colorEnabled(fakeIO({ stdoutTTY: true, env: { NO_COLOR: "1" } }).io, true)).toBe(false);
  });
  it("is off with TERM=dumb", () => {
    expect(colorEnabled(fakeIO({ stdoutTTY: true, env: { TERM: "dumb" } }).io, true)).toBe(false);
  });
  it("is off when --no-color", () => {
    expect(colorEnabled(fakeIO({ stdoutTTY: true }).io, false)).toBe(false);
  });
  it("is on for a plain TTY", () => {
    expect(colorEnabled(fakeIO({ stdoutTTY: true }).io, true)).toBe(true);
  });
});

describe("paintStatus", () => {
  it("leaves text unchanged without color and adds ANSI with color", () => {
    expect(paintStatus("FAILED", false)).toBe("FAILED");
    const painted = paintStatus("FAILED", true);
    expect(painted).not.toBe("FAILED");
    expect(stripVTControlCharacters(painted)).toBe("FAILED");
  });
});

describe("renderTable", () => {
  it("fits the width and truncates with an ellipsis", () => {
    const rows = [{ id: "abc", status: paintStatus("RUNNING", true), note: "x".repeat(200) }];
    const output = renderTable(
      [
        { header: "ID", get: (row: typeof rows[number]) => row.id },
        { header: "STATUS", get: (row) => row.status },
        { header: "NOTE", get: (row) => row.note },
      ],
      rows,
      40,
    );
    const lines = output.split("\n");
    expect(lines[0]).toMatch(/^ID\s+STATUS\s+NOTE/);
    for (const line of lines) expect(stripVTControlCharacters(line).length).toBeLessThanOrEqual(40);
    expect(lines[1]?.endsWith("…")).toBe(true);
  });

  it("truncates columns with max", () => {
    const output = renderTable([{ header: "NAME", get: (r: { n: string }) => r.n, max: 5 }], [{ n: "abcdefgh" }], 80);
    expect(output.split("\n")[1]).toBe("abcd…");
  });
});

describe("run entry point", () => {
  it("prints the version", async () => {
    const fake = fakeIO();
    expect(await run(["--version"], fake.io)).toBe(0);
    expect(fake.stdout().trim()).toBe("0.1.0");
  });

  it("prints help", async () => {
    const fake = fakeIO();
    expect(await run(["--help"], fake.io)).toBe(0);
    expect(fake.stdout()).toContain("Usage: agentflow");
  });

  it("exits 2 on an unknown command with nothing on stdout", async () => {
    const fake = fakeIO();
    expect(await run(["nonsense"], fake.io)).toBe(2);
    expect(fake.stderr()).not.toBe("");
    expect(fake.stdout()).toBe("");
  });
});

describe("version constant", () => {
  it("matches apps/cli/package.json", async () => {
    const { readFile } = await import("node:fs/promises");
    const { VERSION } = await import("../../apps/cli/src/version.js");
    const pkg = JSON.parse(await readFile(new URL("../../apps/cli/package.json", import.meta.url), "utf8")) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});
