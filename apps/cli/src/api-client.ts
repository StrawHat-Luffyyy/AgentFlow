import type {
  approvalDecisionSchema,
  createRunSchema,
  createWorkflowSchema,
  createWorkflowVersionSchema,
  reconciliationDecisionSchema,
} from "@agentflow/shared";
import type { z, ZodType, ZodTypeDef } from "zod";
import type { StoredAuth } from "./config-store.js";
import { apiError, CliError, ExitCode } from "./errors.js";
import type { CliIO } from "./io.js";
import type { Output } from "./output/emit.js";
import {
  approvalsSchema,
  attemptsSchema,
  harnessOpsSchema,
  healthSchema,
  historySchema,
  loginSchema,
  meSchema,
  okSchema,
  readySchema,
  referenceSetupSchema,
  runDetailSchema,
  runListSchema,
  sourcesSchema,
  toolExecutionsSchema,
  usageSchema,
  versionCreatedSchema,
  workflowCreatedSchema,
  workflowDetailSchema,
  workflowListSchema,
} from "./schemas.js";

const SESSION_COOKIE = "agentflow_session";
const DEFAULT_SESSION_MS = 7 * 24 * 60 * 60 * 1000;

export interface ApiClientOptions {
  baseUrl: string;
  auth?: StoredAuth;
  io: CliIO;
  out: Output;
}

interface RequestOptions<T> {
  schema: ZodType<T, ZodTypeDef, unknown>;
  body?: unknown;
  resource?: { kind: string; id: string };
  requiredRole?: string;
  /** false sends no credentials (login). */
  auth?: boolean;
}

/** The only module that speaks HTTP to the AgentFlow API. */
export class ApiClient {
  constructor(private readonly options: ApiClientOptions) {}

  get baseUrl(): string {
    return this.options.baseUrl;
  }

  async request<T>(method: string, path: string, opts: RequestOptions<T>): Promise<T> {
    const { response, body } = await this.send(method, path, opts);
    if (!response.ok) {
      throw apiError(response.status, body, {
        method,
        path,
        ...(this.options.auth ? { authType: this.options.auth.type } : {}),
        ...(opts.resource ? { resource: opts.resource } : {}),
        ...(opts.requiredRole ? { requiredRole: opts.requiredRole } : {}),
      });
    }
    return this.parse(method, path, opts.schema, body);
  }

  private async send(method: string, path: string, opts: { body?: unknown; auth?: boolean }) {
    const { io, out, auth, baseUrl } = this.options;
    const headers: Record<string, string> = { accept: "application/json" };
    const logged: string[] = [];
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    if (opts.auth !== false && auth?.type === "token") {
      headers.authorization = `Bearer ${auth.token}`;
      logged.push("authorization: Bearer ***");
    } else if (opts.auth !== false && auth?.type === "session") {
      headers.cookie = `${SESSION_COOKIE}=${auth.sessionId}`;
      logged.push(`cookie: ${SESSION_COOKIE}=***`);
    }
    out.debug(`→ ${method} ${path}`);
    for (const line of logged) out.debug(`  ${line}`);
    const started = io.now();
    let response: Response;
    try {
      response = await io.fetch(`${baseUrl}${path}`, {
        method,
        headers,
        ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
      });
    } catch (error) {
      throw new CliError(
        `Cannot reach AgentFlow API at ${baseUrl} — is it running?`,
        ExitCode.ERROR,
        "NETWORK",
        error instanceof Error ? { cause: error.message } : undefined,
      );
    }
    out.debug(`← ${response.status} ${method} ${path} (${io.now() - started}ms)`);
    const text = await response.text();
    let body: unknown;
    try {
      body = text === "" ? undefined : JSON.parse(text);
    } catch {
      body = text;
    }
    return { response, body };
  }

  private parse<T>(method: string, path: string, schema: ZodType<T, ZodTypeDef, unknown>, body: unknown): T {
    const result = schema.safeParse(body);
    if (!result.success) {
      throw new CliError(
        `Unexpected response from ${method} ${path} — CLI and API versions may differ`,
        ExitCode.ERROR,
        "BAD_RESPONSE",
        result.error.issues,
      );
    }
    return result.data;
  }

  health() { return this.request("GET", "/health", { schema: healthSchema, auth: false }); }
  ready() { return this.request("GET", "/ready", { schema: readySchema, auth: false }); }
  me() { return this.request("GET", "/me", { schema: meSchema }); }

  async login(username: string, password: string) {
    const path = "/auth/login";
    const { response, body } = await this.send("POST", path, { body: { username, password }, auth: false });
    if (!response.ok) {
      if (response.status === 401) {
        throw new CliError("Invalid username or password", ExitCode.AUTH, "INVALID_CREDENTIALS");
      }
      throw apiError(response.status, body, { method: "POST", path });
    }
    const { user } = this.parse("POST", path, loginSchema, body);
    const cookie = response.headers.getSetCookie().find((line) => line.startsWith(`${SESSION_COOKIE}=`));
    if (!cookie) {
      throw new CliError("Login succeeded but the API returned no session cookie", ExitCode.ERROR, "BAD_RESPONSE");
    }
    const [pair = "", ...attributes] = cookie.split(";").map((part) => part.trim());
    const sessionId = pair.slice(SESSION_COOKIE.length + 1);
    let expiresMs = this.options.io.now() + DEFAULT_SESSION_MS;
    for (const attribute of attributes) {
      const [name = "", value = ""] = attribute.split("=");
      if (name.toLowerCase() === "max-age" && Number.isFinite(Number(value))) {
        expiresMs = this.options.io.now() + Number(value) * 1000;
        break;
      }
      if (name.toLowerCase() === "expires" && !Number.isNaN(Date.parse(value))) expiresMs = Date.parse(value);
    }
    return { user, sessionId, expiresAt: new Date(expiresMs).toISOString() };
  }

  logout() { return this.request("POST", "/auth/logout", { schema: okSchema }); }

  listWorkflows() { return this.request("GET", "/workflows", { schema: workflowListSchema }); }
  getWorkflow(id: string) {
    return this.request("GET", `/workflows/${id}`, { schema: workflowDetailSchema, resource: { kind: "Workflow", id } });
  }
  createWorkflow(body: z.input<typeof createWorkflowSchema>) {
    return this.request("POST", "/workflows", { schema: workflowCreatedSchema, body });
  }
  publishVersion(id: string, body: z.input<typeof createWorkflowVersionSchema>) {
    return this.request("POST", `/workflows/${id}/versions`, {
      schema: versionCreatedSchema, body, resource: { kind: "Workflow", id },
    });
  }
  setupReference(body: Record<string, unknown>) {
    return this.request("POST", "/reference-workflows/cloud-comparison", { schema: referenceSetupSchema, body });
  }

  listRuns(query: { limit: number; offset: number }) {
    return this.request("GET", `/runs?limit=${query.limit}&offset=${query.offset}`, { schema: runListSchema });
  }
  getRun(id: string) {
    return this.request("GET", `/runs/${id}`, { schema: runDetailSchema, resource: { kind: "Run", id } });
  }
  createRun(body: z.input<typeof createRunSchema>) {
    return this.request("POST", "/runs", {
      schema: runDetailSchema, body, resource: { kind: "Workflow version", id: body.workflowVersionId },
    });
  }
  runHistory(id: string) { return this.runResource(id, "history", historySchema); }
  runAttempts(id: string) { return this.runResource(id, "attempts", attemptsSchema); }
  runApprovals(id: string) { return this.runResource(id, "approvals", approvalsSchema); }
  runToolExecutions(id: string) { return this.runResource(id, "tool-executions", toolExecutionsSchema); }
  runHarnessOps(id: string) { return this.runResource(id, "harness-operations", harnessOpsSchema); }
  runUsage(id: string) { return this.runResource(id, "usage", usageSchema); }
  runSources(id: string) { return this.runResource(id, "sources", sourcesSchema); }
  controlRun(id: string, command: "pause" | "resume" | "cancel") {
    return this.request("POST", `/runs/${id}/${command}`, { schema: runDetailSchema, resource: { kind: "Run", id } });
  }

  listApprovals(query: { runId?: string } = {}) {
    const suffix = query.runId ? `?runId=${encodeURIComponent(query.runId)}` : "";
    return this.request("GET", `/approvals${suffix}`, { schema: approvalsSchema });
  }
  decideApproval(id: string, body: z.input<typeof approvalDecisionSchema>, requiredRole: string) {
    return this.request("POST", `/approvals/${id}/decisions`, {
      schema: okSchema, body, requiredRole, resource: { kind: "Approval", id },
    });
  }
  reconcile(id: string, body: z.input<typeof reconciliationDecisionSchema>) {
    return this.request("POST", `/tool-executions/${id}/reconcile`, {
      schema: okSchema, body, requiredRole: "operator", resource: { kind: "Tool execution", id },
    });
  }

  private runResource<T>(id: string, resource: string, schema: ZodType<T, ZodTypeDef, unknown>) {
    return this.request("GET", `/runs/${id}/${resource}`, { schema, resource: { kind: "Run", id } });
  }
}
