import type { Command } from "commander";
import { maskSecrets } from "../config-store.js";
import type { ContextFactory } from "../context.js";
import { UsageError } from "../errors.js";
import { renderTable } from "../output/table.js";

const SETTABLE_KEYS = ["url"] as const;

function validateUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new UsageError(`"${value}" is not a valid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new UsageError(`URL must use http or https, got ${parsed.protocol}`);
  }
  return value.replace(/\/+$/, "");
}

export function registerConfigCommands(program: Command, getContext: ContextFactory): void {
  const config = program.command("config").description("view and edit CLI profiles");

  config
    .command("list")
    .description("show all profiles (secrets masked)")
    .action(async () => {
      const ctx = await getContext();
      const masked = maskSecrets(ctx.config);
      ctx.out.data({ path: ctx.store.path, ...masked }, {
        render: () => {
          const rows = Object.entries(masked.profiles).map(([name, profile]) => ({ name, profile }));
          const table = renderTable([
            { header: "", get: (row) => (row.name === masked.currentProfile ? "*" : "") },
            { header: "PROFILE", get: (row) => row.name },
            { header: "URL", get: (row) => row.profile.url ?? "(default)" },
            {
              header: "AUTH",
              get: (row) => (row.profile.auth?.type === "token" ? `token ${row.profile.auth.token}`
                : row.profile.auth?.type === "session" ? `session ${row.profile.auth.username} ${row.profile.auth.sessionId}`
                  : "none"),
            },
          ], rows, ctx.out.width);
          return `config: ${ctx.store.path}\n${rows.length > 0 ? table : "(no profiles)"}`;
        },
        ids: () => Object.keys(masked.profiles),
      });
    });

  config
    .command("get <key>")
    .description("print a setting for the selected profile (url, profile)")
    .action(async (key: string) => {
      const ctx = await getContext();
      const values: Record<string, string> = { url: ctx.settings.baseUrl, profile: ctx.settings.profileName };
      const value = values[key];
      if (value === undefined) throw new UsageError(`Unknown key "${key}" — expected one of: ${Object.keys(values).join(", ")}`);
      ctx.out.data({ [key]: value }, { render: () => value });
    });

  config
    .command("set <key> <value>")
    .description("change a non-secret setting on the selected profile (url)")
    .action(async (key: string, value: string) => {
      if (!(SETTABLE_KEYS as readonly string[]).includes(key)) {
        throw new UsageError(`Cannot set "${key}" — settable keys: ${SETTABLE_KEYS.join(", ")} (use \`agentflow login\` for credentials)`);
      }
      const url = validateUrl(value);
      const ctx = await getContext();
      await ctx.store.update((stored) => {
        (stored.profiles[ctx.settings.profileName] ??= {}).url = url;
      });
      ctx.out.data({ profile: ctx.settings.profileName, url }, {
        render: () => `Set url = ${url} on profile ${ctx.settings.profileName}`,
      });
    });

  config
    .command("use <profile>")
    .description("make a profile the default (created if missing)")
    .action(async (profile: string) => {
      const ctx = await getContext();
      await ctx.store.update((stored) => {
        stored.currentProfile = profile;
        stored.profiles[profile] ??= {};
      });
      ctx.out.data({ currentProfile: profile }, { render: () => `Now using profile ${profile}` });
    });
}
