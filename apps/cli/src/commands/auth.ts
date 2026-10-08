import type { Command } from "commander";
import { ApiClient } from "../api-client.js";
import type { StoredAuth } from "../config-store.js";
import type { CliContext, ContextFactory } from "../context.js";
import { CliError, ExitCode, UsageError } from "../errors.js";
import { formatRelative } from "../output/duration.js";
import { renderFields } from "../output/fields.js";
import { ask, askSecret, readLine } from "../prompt.js";
import type { Me } from "../schemas.js";

async function saveAuth(ctx: CliContext, auth: StoredAuth): Promise<void> {
  await ctx.store.update((config) => {
    const profile = (config.profiles[ctx.settings.profileName] ??= {});
    profile.url = ctx.settings.baseUrl;
    profile.auth = auth;
  });
}

function renderIdentity(ctx: CliContext, me: Me, authLabel: string): string {
  return renderFields([
    ["id", me.id],
    ...(me.username ? [["username", me.username] as [string, string]] : []),
    ["roles", me.roles.length > 0 ? me.roles.join(", ") : "(none)"],
    ["profile", ctx.settings.profileName],
    ["url", ctx.settings.baseUrl],
    ["auth", authLabel],
  ]);
}

function authLabel(ctx: CliContext): string {
  const { auth, authSource } = ctx.settings;
  if (authSource === "env") return "env token";
  if (auth?.type === "session") return `session (expires ${formatRelative(auth.expiresAt, ctx.io.now())})`;
  return auth ? "token" : "none";
}

async function loginWithToken(ctx: CliContext): Promise<void> {
  const token = ctx.io.stdin.isTTY ? await askSecret(ctx.io, "API token: ") : (await readLine(ctx.io)).trim();
  if (token === "") throw new UsageError("No token provided");
  const auth: StoredAuth = { type: "token", token };
  const client = new ApiClient({ baseUrl: ctx.settings.baseUrl, io: ctx.io, out: ctx.out, auth });
  const me = await client.me();
  await saveAuth(ctx, auth);
  ctx.out.data(me, {
    render: () => `Logged in to ${ctx.settings.baseUrl} as ${me.username ?? me.id} (profile ${ctx.settings.profileName})`,
    ids: () => [me.id],
  });
}

async function loginWithPassword(ctx: CliContext, username: string | undefined): Promise<void> {
  if (!ctx.io.stdin.isTTY) {
    throw new UsageError("Password login needs an interactive terminal; pipe a token to `agentflow login --token` instead");
  }
  const name = username ?? await ask(ctx.io, "Username: ");
  if (name === "") throw new UsageError("No username provided");
  const password = await askSecret(ctx.io, "Password: ");
  const client = new ApiClient({ baseUrl: ctx.settings.baseUrl, io: ctx.io, out: ctx.out });
  const { user, sessionId, expiresAt } = await client.login(name, password);
  await saveAuth(ctx, { type: "session", sessionId, username: user.username, expiresAt });
  ctx.out.data({ user }, {
    render: () => `Logged in to ${ctx.settings.baseUrl} as ${user.username} (profile ${ctx.settings.profileName})`,
    ids: () => [user.id],
  });
}

export function registerAuthCommands(program: Command, getContext: ContextFactory): void {
  program
    .command("login")
    .description("log in with a username and password, or store an API token")
    .option("--token", "store a bearer token (read from stdin when piped, otherwise prompted)")
    .option("--username <username>", "username for password login")
    .action(async (opts: { token?: boolean; username?: string }) => {
      const ctx = await getContext();
      if (opts.token) await loginWithToken(ctx);
      else await loginWithPassword(ctx, opts.username);
    });

  program
    .command("logout")
    .description("end the session and remove stored credentials from the profile")
    .action(async () => {
      const ctx = await getContext();
      const stored = ctx.config.profiles[ctx.settings.profileName]?.auth;
      if (stored?.type === "session") {
        const client = new ApiClient({ baseUrl: ctx.settings.baseUrl, io: ctx.io, out: ctx.out, auth: stored });
        try {
          await client.logout();
        } catch (error) {
          ctx.out.warn(`Could not end the server session: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      await ctx.store.update((config) => {
        const profile = config.profiles[ctx.settings.profileName];
        if (profile) delete profile.auth;
      });
      if (ctx.settings.authSource === "env") ctx.out.warn("AGENTFLOW_TOKEN is still set in the environment");
      ctx.out.data({ profile: ctx.settings.profileName, loggedOut: true }, {
        render: () => `Logged out of profile ${ctx.settings.profileName}`,
      });
    });

  program
    .command("whoami")
    .description("show the authenticated identity")
    .action(async () => {
      const ctx = await getContext();
      if (!ctx.settings.auth) {
        throw new CliError("Not logged in — run `agentflow login`", ExitCode.AUTH, "UNAUTHENTICATED");
      }
      const me = await ctx.client.me();
      ctx.out.data(me, { render: () => renderIdentity(ctx, me, authLabel(ctx)), ids: () => [me.id] });
    });
}
