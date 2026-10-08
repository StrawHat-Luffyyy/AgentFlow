import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, posix, win32 } from "node:path";
import { z } from "zod";
import { CliError, ExitCode } from "./errors.js";
import type { CliIO } from "./io.js";

const storedAuthSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("token"), token: z.string().min(1) }),
  z.object({
    type: z.literal("session"),
    sessionId: z.string().min(1),
    username: z.string(),
    expiresAt: z.string(),
  }),
]);

const profileSchema = z.object({
  url: z.string().optional(),
  auth: storedAuthSchema.optional(),
});

export const configSchema = z.object({
  currentProfile: z.string().default("default"),
  profiles: z.record(z.string(), profileSchema).default({}),
});

export type StoredAuth = z.infer<typeof storedAuthSchema>;
export type Profile = z.infer<typeof profileSchema>;
export type Config = z.infer<typeof configSchema>;

export function configPath(io: CliIO): string {
  if (io.env.AGENTFLOW_CONFIG) return io.env.AGENTFLOW_CONFIG;
  if (io.platform === "win32") {
    const base = io.env.APPDATA ?? win32.join(io.homedir, "AppData", "Roaming");
    return win32.join(base, "agentflow", "config.json");
  }
  const base = io.env.XDG_CONFIG_HOME || posix.join(io.homedir, ".config");
  return posix.join(base, "agentflow", "config.json");
}

export function maskSecrets(config: Config): Config {
  const profiles = Object.fromEntries(Object.entries(config.profiles).map(([name, profile]) => {
    const auth = profile.auth?.type === "token" ? { ...profile.auth, token: "***" }
      : profile.auth?.type === "session" ? { ...profile.auth, sessionId: "***" }
        : undefined;
    return [name, auth ? { ...profile, auth } : profile];
  }));
  return { ...config, profiles };
}

export class ConfigStore {
  constructor(readonly path: string) {}

  async load(): Promise<Config> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return configSchema.parse({});
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new CliError(`Config file ${this.path} is not valid JSON; fix or delete it`, ExitCode.ERROR, "CONFIG_INVALID");
    }
    const result = configSchema.safeParse(parsed);
    if (!result.success) {
      throw new CliError(
        `Config file ${this.path} has an invalid structure; fix or delete it`,
        ExitCode.ERROR,
        "CONFIG_INVALID",
        result.error.issues,
      );
    }
    return result.data;
  }

  async save(config: Config): Promise<void> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    // mode on writeFile is masked by umask; enforce it explicitly.
    await chmod(temporary, 0o600);
    await rename(temporary, this.path);
  }

  async update(mutate: (config: Config) => void): Promise<Config> {
    const config = await this.load();
    mutate(config);
    await this.save(config);
    return config;
  }
}
