import { ConfigStore, configPath, type Config, type StoredAuth } from "./config-store.js";
import type { CliIO } from "./io.js";
import { Output } from "./output/emit.js";
import { colorEnabled } from "./output/style.js";

export const DEFAULT_URL = "http://localhost:3000";

export interface GlobalFlags {
  profile?: string;
  url?: string;
  json: boolean;
  color: boolean;
  quiet: boolean;
  verbose: boolean;
}

export interface Settings {
  profileName: string;
  baseUrl: string;
  auth?: StoredAuth;
  authSource: "env" | "profile" | "none";
}

export interface CliContext {
  io: CliIO;
  out: Output;
  flags: GlobalFlags;
  store: ConfigStore;
  config: Config;
  settings: Settings;
}

export function resolveSettings(config: Config, flags: GlobalFlags, env: CliIO["env"]): Settings {
  const profileName = flags.profile ?? env.AGENTFLOW_PROFILE ?? config.currentProfile ?? "default";
  const profile = config.profiles[profileName] ?? {};
  const baseUrl = (flags.url ?? env.AGENTFLOW_URL ?? profile.url ?? DEFAULT_URL).replace(/\/+$/, "");
  if (env.AGENTFLOW_TOKEN) {
    return { profileName, baseUrl, auth: { type: "token", token: env.AGENTFLOW_TOKEN }, authSource: "env" };
  }
  return profile.auth
    ? { profileName, baseUrl, auth: profile.auth, authSource: "profile" }
    : { profileName, baseUrl, authSource: "none" };
}

export async function createContext(io: CliIO, flags: GlobalFlags): Promise<CliContext> {
  const out = new Output(io, {
    json: flags.json,
    quiet: flags.quiet,
    verbose: flags.verbose,
    color: colorEnabled(io, flags.color),
  });
  const store = new ConfigStore(configPath(io));
  const config = await store.load();
  return { io, out, flags, store, config, settings: resolveSettings(config, flags, io.env) };
}
