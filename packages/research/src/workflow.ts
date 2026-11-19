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
  /**
   * Per-step context minimization (brief §2.4). "minimal": each analysis step sees only
   * the corpus and the workload assumptions. "full": the original definition, where each
   * analysis prompt carries the whole accumulated state (kept for comparable campaigns).
   */
  context: z.enum(["minimal", "full"]).default("minimal"),
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

/** What each analysis step needs: the verified corpus and the workload assumptions, nothing else. */
export const cloudComparisonAnalysisInputs = ["sourceSet", "request.assumptions"] as const;

export function cloudComparisonWorkflowDefinition(raw: Partial<CloudComparisonSetup> = {}): WorkflowDefinition {
  const setup = cloudComparisonSetupSchema.parse(raw);
  const provider = setup.mode === "scripted" ? "scripted-research" : setup.provider!;
  const model = setup.mode === "scripted" ? "cloud-comparison-scripted-v1" : setup.model!;
  const inputs = setup.context === "minimal" ? { inputs: [...cloudComparisonAnalysisInputs] } : {};
  // Live campaigns sample as deterministically as the provider allows; scripted
  // definitions stay byte-identical to the ones the cited evidence used.
  const sampling = setup.mode === "live" ? { temperature: 0, seed: 7 } : {};
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
        ...inputs,
        ...sampling,
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
        ...inputs,
        ...sampling,
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
  ownerId = "legacy-unassigned",
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
      `INSERT INTO workflows (id, name, description, owner_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (owner_id, name) DO NOTHING
       RETURNING id`,
      [workflowId, workflowName, "Reference AWS/Azure/GCP comparison over the fixed evaluation corpus", ownerId],
    );
    const resolvedWorkflowId = inserted.rows[0]?.id ?? (await transaction.query<{ id: string }>(
      "SELECT id FROM workflows WHERE name = $1 AND owner_id = $2",
      [workflowName, ownerId],
    )).rows[0]!.id;
    // Versions are immutable: reuse the version with this exact definition, otherwise
    // append the next version number (e.g. when the reference definition changes).
    const findVersion = async () => (await transaction.query<{ id: string; version: number }>(
      "SELECT id, version FROM workflow_versions WHERE workflow_id = $1 AND definition_hash = $2",
      [resolvedWorkflowId, definitionHash],
    )).rows[0];
    let resolvedVersion = await findVersion();
    let createdVersion = false;
    for (let attempt = 0; !resolvedVersion && attempt < 5; attempt += 1) {
      const inserted = await transaction.query<{ id: string; version: number }>(
        `INSERT INTO workflow_versions
           (id, workflow_id, version, definition_json, definition_hash)
         SELECT $1, $2, COALESCE(MAX(version), 0) + 1, $3::jsonb, $4
         FROM workflow_versions WHERE workflow_id = $2
         ON CONFLICT DO NOTHING
         RETURNING id, version`,
        [randomUUID(), resolvedWorkflowId, JSON.stringify(definition), definitionHash],
      );
      createdVersion = inserted.rowCount === 1;
      resolvedVersion = inserted.rows[0] ?? await findVersion();
    }
    if (!resolvedVersion) throw new Error(`Could not register a version of reference workflow ${workflowName}`);
    return {
      workflowId: resolvedWorkflowId,
      workflowVersionId: resolvedVersion.id,
      workflowName,
      version: resolvedVersion.version,
      mode: setup.mode,
      provider,
      model,
      created: createdVersion,
      definition,
    };
  });
}
