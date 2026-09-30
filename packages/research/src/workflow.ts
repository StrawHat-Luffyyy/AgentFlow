import { createHash, randomUUID } from "node:crypto";
import { withTransaction, type Database } from "@agentflow/db";
import { canonicalJson, workflowDefinitionSchema, type WorkflowDefinition } from "@agentflow/shared";
import { z } from "zod";

export const cloudComparisonSetupSchema = z.object({
  mode: z.enum(["scripted", "live"]).default("scripted"),
  provider: z.string().trim().min(1).max(100).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  reviewerRole: z.string().trim().min(1).max(100).default("research-reviewer"),
  approvalExpiresAfterMs: z.number().int().min(1_000).max(30 * 24 * 60 * 60 * 1_000)
    .default(24 * 60 * 60 * 1_000),
}).superRefine((input, context) => {
  if (input.mode === "live" && (!input.provider || !input.model)) {
    context.addIssue({
      code: "custom",
      message: "Live mode requires provider and model",
      path: [input.provider ? "model" : "provider"],
    });
  }
});

export type CloudComparisonSetup = z.infer<typeof cloudComparisonSetupSchema>;

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function workflowIdentity(provider: string, model: string): string {
  const slug = `${provider}-${model}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${slug.slice(0, 48)}-${hash({ provider, model }).slice(0, 8)}`;
}

export function cloudComparisonWorkflowDefinition(raw: Partial<CloudComparisonSetup> = {}): WorkflowDefinition {
  const setup = cloudComparisonSetupSchema.parse(raw);
  const provider = setup.mode === "scripted" ? "scripted-research" : setup.provider!;
  const model = setup.mode === "scripted" ? "cloud-comparison-scripted-v1" : setup.model!;
  return workflowDefinitionSchema.parse({
    steps: [
      { key: "search-aws", kind: "DETERMINISTIC", handler: "select-aws-sources" },
      { key: "search-azure", kind: "DETERMINISTIC", handler: "select-azure-sources" },
      { key: "search-gcp", kind: "DETERMINISTIC", handler: "select-gcp-sources" },
      { key: "collect-sources", kind: "DETERMINISTIC", handler: "collect-sources" },
      {
        key: "analyze-pricing",
        kind: "AGENT",
        handler: "agent",
        provider,
        model,
        instructions: "[cloud-comparison:pricing] Analyze pricing only from the committed fixed corpus. Preserve workload assumptions, do not invent live prices, and cite source IDs in square brackets.",
        allowedTools: [],
        maxTurns: 2,
        maxOutputTokens: 1_500,
        outputKey: "pricingAnalysis",
      },
      {
        key: "analyze-features",
        kind: "AGENT",
        handler: "agent",
        provider,
        model,
        instructions: "[cloud-comparison:features] Compare managed Kubernetes operating models only from the committed fixed corpus. Avoid declaring a universal winner and cite source IDs in square brackets.",
        allowedTools: [],
        maxTurns: 2,
        maxOutputTokens: 1_500,
        outputKey: "featureAnalysis",
      },
      { key: "generate-report", kind: "DETERMINISTIC", handler: "generate-cloud-report" },
      {
        key: "approve-publication",
        kind: "APPROVAL",
        handler: "approval",
        reviewerRole: setup.reviewerRole,
        expiresAfterMs: setup.approvalExpiresAfterMs,
      },
      {
        key: "publish-report",
        kind: "TOOL",
        handler: "publish-approved-report",
        toolVersion: "1",
        effectClass: "RECEIVER_IDEMPOTENT_WRITE",
      },
    ],
  });
}

export async function ensureCloudComparisonWorkflow(
  database: Database,
  raw: Partial<CloudComparisonSetup> = {},
) {
  const setup = cloudComparisonSetupSchema.parse(raw);
  const provider = setup.mode === "scripted" ? "scripted-research" : setup.provider!;
  const model = setup.mode === "scripted" ? "cloud-comparison-scripted-v1" : setup.model!;
  const definition = cloudComparisonWorkflowDefinition(setup);
  const definitionHash = hash(definition);
  const workflowName = setup.mode === "scripted"
    ? "cloud-comparison-scripted"
    : `cloud-comparison-${workflowIdentity(provider, model)}`;
  return withTransaction(database, async (transaction) => {
    const workflowId = randomUUID();
    const inserted = await transaction.query<{ id: string }>(
      `INSERT INTO workflows (id, name, description)
       VALUES ($1, $2, $3)
       ON CONFLICT (name) DO NOTHING
       RETURNING id`,
      [workflowId, workflowName, "Reference AWS/Azure/GCP comparison over the fixed evaluation corpus"],
    );
    const resolvedWorkflowId = inserted.rows[0]?.id ?? (await transaction.query<{ id: string }>(
      "SELECT id FROM workflows WHERE name = $1",
      [workflowName],
    )).rows[0]!.id;
    const proposedVersionId = randomUUID();
    const insertedVersion = await transaction.query<{ id: string; definition_hash: string }>(
      `INSERT INTO workflow_versions
         (id, workflow_id, version, definition_json, definition_hash)
       VALUES ($1, $2, 1, $3::jsonb, $4)
       ON CONFLICT (workflow_id, version) DO NOTHING
       RETURNING id, definition_hash`,
      [proposedVersionId, resolvedWorkflowId, JSON.stringify(definition), definitionHash],
    );
    const createdVersion = insertedVersion.rows[0];
    const resolvedVersion = createdVersion ?? (await transaction.query<{
      id: string;
      definition_hash: string;
    }>(
      "SELECT id, definition_hash FROM workflow_versions WHERE workflow_id = $1 AND version = 1",
      [resolvedWorkflowId],
    )).rows[0]!;
    if (resolvedVersion.definition_hash !== definitionHash) {
      throw new Error(`Reference workflow ${workflowName} version 1 already has a different definition`);
    }
    return {
      workflowId: resolvedWorkflowId,
      workflowVersionId: resolvedVersion.id,
      workflowName,
      version: 1,
      mode: setup.mode,
      provider,
      model,
      created: Boolean(createdVersion),
      definition,
    };
  });
}
