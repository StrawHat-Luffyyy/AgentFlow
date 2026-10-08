import { mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { CliError } from "../../apps/cli/src/errors.js";
import { ConfigStore, configPath, maskSecrets, type Config } from "../../apps/cli/src/config-store.js";
import { resolveSettings, type GlobalFlags } from "../../apps/cli/src/context.js";
import { fakeIO } from "./cli-helpers.js";

const flags = (overrides: Partial<GlobalFlags> = {}): GlobalFlags => ({
  json: false, color: true, quiet: false, verbose: false, ...overrides,
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agentflow-cli-config-"));
});

describe("ConfigStore", () => {
  it("returns defaults when the file is missing", async () => {
    const store = new ConfigStore(join(dir, "nested", "config.json"));
    expect(await store.load()).toEqual({ currentProfile: "default", profiles: {} });
  });

  it("round-trips, writes 0600, and leaves no temp files", async () => {
    const path = join(dir, "agentflow", "config.json");
    const store = new ConfigStore(path);
    const config: Config = {
      currentProfile: "prod",
      profiles: { prod: { url: "https://x", auth: { type: "token", token: "t0k3n" } } },
    };
    await store.save(config);
    expect(await store.load()).toEqual(config);
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await readdir(join(dir, "agentflow"))).filter((name) => name.includes(".tmp"))).toEqual([]);
  });

  it.each(["{not json", '{"profiles": 5}'])("rejects corrupt file %j naming the path without overwriting", async (content) => {
    const path = join(dir, "config.json");
    await writeFile(path, content);
    const store = new ConfigStore(path);
    const error = await store.load().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).exitCode).toBe(1);
    expect((error as CliError).message).toContain(path);
    expect(await readFile(path, "utf8")).toBe(content);
  });

  it("update applies a mutation and persists it", async () => {
    const store = new ConfigStore(join(dir, "config.json"));
    await store.update((config) => { config.profiles.dev = { url: "http://dev" }; });
    expect((await store.load()).profiles.dev).toEqual({ url: "http://dev" });
  });
});

describe("configPath", () => {
  it("uses APPDATA on Windows", () => {
    const { io } = fakeIO({ platform: "win32", env: { APPDATA: "C:\\A" } });
    expect(configPath(io)).toBe("C:\\A\\agentflow\\config.json");
  });
  it("uses XDG_CONFIG_HOME on Linux", () => {
    const { io } = fakeIO({ platform: "linux", env: { XDG_CONFIG_HOME: "/x" } });
    expect(configPath(io)).toBe("/x/agentflow/config.json");
  });
  it("falls back to ~/.config", () => {
    const { io } = fakeIO({ platform: "darwin", homedir: "/Users/u" });
    expect(configPath(io)).toBe("/Users/u/.config/agentflow/config.json");
  });
  it("honours AGENTFLOW_CONFIG", () => {
    const { io } = fakeIO({ platform: "win32", env: { APPDATA: "C:\\A", AGENTFLOW_CONFIG: "/tmp/c.json" } });
    expect(configPath(io)).toBe("/tmp/c.json");
  });
});

describe("resolveSettings", () => {
  const config: Config = {
    currentProfile: "default",
    profiles: {
      default: { url: "http://profile:3000/", auth: { type: "session", sessionId: "s1", username: "alice", expiresAt: "2026-10-15T00:00:00.000Z" } },
      prod: { url: "https://prod" },
      dev: { url: "https://dev" },
    },
  };

  it("uses the current profile and strips the trailing slash", () => {
    const settings = resolveSettings(config, flags(), {});
    expect(settings).toMatchObject({ profileName: "default", baseUrl: "http://profile:3000", authSource: "profile" });
    expect(settings.auth).toMatchObject({ type: "session", sessionId: "s1" });
  });
  it("AGENTFLOW_URL beats the profile and --url beats env", () => {
    expect(resolveSettings(config, flags(), { AGENTFLOW_URL: "http://env" }).baseUrl).toBe("http://env");
    expect(resolveSettings(config, flags({ url: "http://flag" }), { AGENTFLOW_URL: "http://env" }).baseUrl).toBe("http://flag");
  });
  it("AGENTFLOW_PROFILE selects a profile and --profile beats it", () => {
    expect(resolveSettings(config, flags(), { AGENTFLOW_PROFILE: "prod" }).baseUrl).toBe("https://prod");
    expect(resolveSettings(config, flags({ profile: "dev" }), { AGENTFLOW_PROFILE: "prod" }).profileName).toBe("dev");
  });
  it("defaults to localhost:3000 with no auth", () => {
    expect(resolveSettings({ currentProfile: "default", profiles: {} }, flags(), {}))
      .toEqual({ profileName: "default", baseUrl: "http://localhost:3000", authSource: "none" });
  });
  it("AGENTFLOW_TOKEN overrides profile auth", () => {
    const settings = resolveSettings(config, flags(), { AGENTFLOW_TOKEN: "envtok" });
    expect(settings.auth).toEqual({ type: "token", token: "envtok" });
    expect(settings.authSource).toBe("env");
  });
});

describe("maskSecrets", () => {
  it("masks tokens and session ids only", () => {
    const masked = maskSecrets({
      currentProfile: "a",
      profiles: {
        a: { url: "http://a", auth: { type: "token", token: "secret" } },
        b: { auth: { type: "session", sessionId: "sid", username: "bob", expiresAt: "x" } },
      },
    });
    expect(masked.profiles.a).toEqual({ url: "http://a", auth: { type: "token", token: "***" } });
    expect(masked.profiles.b?.auth).toEqual({ type: "session", sessionId: "***", username: "bob", expiresAt: "x" });
  });
});
