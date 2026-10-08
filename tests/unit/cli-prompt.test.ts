import { describe, expect, it } from "vitest";
import { CliError, UsageError } from "../../apps/cli/src/errors.js";
import { askSecret, confirm, readLine, readStdin } from "../../apps/cli/src/prompt.js";
import { fakeIO } from "./cli-helpers.js";

describe("askSecret", () => {
  it("reads masked input with backspace handling and echoes nothing", async () => {
    const fake = fakeIO({ stdinTTY: true });
    const answer = askSecret(fake.io, "Password: ");
    fake.feed("pa\u007fss\r");
    expect(await answer).toBe("pss");
    expect(fake.stderr()).toContain("Password: ");
    expect(fake.stderr()).not.toContain("pss");
  });

  it("treats Ctrl-C as an interrupt", async () => {
    const fake = fakeIO({ stdinTTY: true });
    const answer = askSecret(fake.io, "Password: ").catch((e: unknown) => e);
    fake.feed("ab\u0003");
    const error = await answer;
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).exitCode).toBe(130);
  });
});

describe("confirm", () => {
  it("refuses without --yes when stdin is not a TTY", async () => {
    const fake = fakeIO();
    await expect(confirm(fake.io, "cancel run abc", { yes: false })).rejects.toBeInstanceOf(UsageError);
  });

  it("returns true with --yes without prompting", async () => {
    const fake = fakeIO();
    expect(await confirm(fake.io, "cancel run abc", { yes: true })).toBe(true);
    expect(fake.stderr()).toBe("");
  });

  it("asks on a TTY and accepts y", async () => {
    const fake = fakeIO({ stdinTTY: true });
    const answer = confirm(fake.io, "cancel run abc", { yes: false });
    fake.feed("y\n");
    expect(await answer).toBe(true);
    expect(fake.stderr()).toContain("Cancel run abc? [y/N]");
  });

  it("treats anything else as no", async () => {
    const fake = fakeIO({ stdinTTY: true });
    const answer = confirm(fake.io, "cancel run abc", { yes: false });
    fake.feed("\n");
    expect(await answer).toBe(false);
  });
});

describe("stdin readers", () => {
  it("readLine returns one line and leaves the rest", async () => {
    const fake = fakeIO();
    fake.feed("first\r\nsecond\n");
    expect(await readLine(fake.io)).toBe("first");
    expect(await readLine(fake.io)).toBe("second");
  });

  it("readStdin reads until end of input", async () => {
    const fake = fakeIO();
    const all = readStdin(fake.io);
    fake.feed('{"a":');
    fake.feed("1}");
    fake.endInput();
    expect(await all).toBe('{"a":1}');
  });
});
