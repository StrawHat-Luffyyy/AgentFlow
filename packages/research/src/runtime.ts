import { createHash } from "node:crypto";
import type { Database } from "@agentflow/db";
import { withTransaction } from "@agentflow/db";
import { canonicalJson } from "@agentflow/shared";
import {
  cloudComparisonCorpusHash,
  cloudComparisonCorpusVersion,
  fixedSourceContentHash,
  fixedCloudComparisonCorpus,
  type CloudVendor,
  type FixedSourceDocument,
} from "./corpus.js";

export interface ReferenceOperation {
  runId: string;
  operationId: string;
  attemptId: string;
  leaseEpoch: number;
  workerId: string;
  handler: string;
  input: Record<string, unknown>;
}

interface ReferenceState {
  request: Record<string, unknown>;
  sourceSet: {
    corpusVersion: string;
    corpusHash: string;
    sources: FixedSourceDocument[];
  };
  [key: string]: unknown;
}

const referenceHandlers = new Set([
  "select-aws-sources",
  "select-azure-sources",
  "select-gcp-sources",
  "collect-sources",
  "generate-cloud-report",
]);

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stateFrom(input: Record<string, unknown>): ReferenceState {
  if (input.request && input.sourceSet) {
    const sourceSet = asRecord(input.sourceSet, "sourceSet");
    if (!Array.isArray(sourceSet.sources)) throw new Error("sourceSet.sources must be an array");
    return input as ReferenceState;
  }
  return {
    request: input,
    sourceSet: {
      corpusVersion: cloudComparisonCorpusVersion,
      corpusHash: cloudComparisonCorpusHash,
      sources: [],
    },
  };
}

async function persistSourceEvidence(
  database: Database,
  operation: ReferenceOperation,
  sources: readonly FixedSourceDocument[],
): Promise<void> {
  await withTransaction(database, async (transaction) => {
    const fence = await transaction.query<{
      lifecycle: string;
      control: string;
      step_status: string;
      lease_owner: string | null;
      lease_epoch: number;
      lease_valid: boolean;
      attempt_status: string;
    }>(
      `SELECT wr.lifecycle, wr.control, ws.status AS step_status, ws.lease_owner,
         ws.lease_epoch, (ws.lease_expires_at > now()) AS lease_valid,
         sa.status AS attempt_status
       FROM workflow_runs wr
       JOIN workflow_steps ws ON ws.run_id = wr.id
       JOIN step_attempts sa ON sa.step_id = ws.id
       WHERE wr.id = $1 AND ws.id = $2 AND sa.id = $3
       FOR UPDATE OF wr, ws, sa`,
      [operation.runId, operation.operationId, operation.attemptId],
    );
    const row = fence.rows[0];
    if (
      !row || row.lifecycle !== "OPEN" || row.control !== "RUN" ||
      row.step_status !== "RUNNING" || row.lease_owner !== operation.workerId ||
      row.lease_epoch !== operation.leaseEpoch || !row.lease_valid ||
      row.attempt_status !== "RUNNING"
    ) {
      throw new Error("Source evidence persistence rejected by lease fencing");
    }
    for (const source of sources) {
      await transaction.query(
        `INSERT INTO research_sources
           (id, corpus_version, vendor, category, title, publisher, source_url,
            retrieved_at, excerpt, content_hash, metadata_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
         ON CONFLICT (id) DO NOTHING`,
        [
          source.id, source.corpusVersion, source.vendor, source.category,
          source.title, source.publisher, source.sourceUrl, source.retrievedAt,
          source.excerpt, source.contentHash,
          JSON.stringify({ retrievalMethod: "fixed-evaluation-snapshot" }),
        ],
      );
      const persisted = await transaction.query<{
        corpus_version: string;
        vendor: string;
        category: string;
        title: string;
        publisher: string;
        source_url: string;
        retrieved_at: Date;
        excerpt: string;
        content_hash: string;
      }>(
        `SELECT corpus_version, vendor, category, title, publisher, source_url,
           retrieved_at, excerpt, content_hash
         FROM research_sources WHERE id = $1`,
        [source.id],
      );
      const saved = persisted.rows[0];
      if (
        !saved || saved.corpus_version !== source.corpusVersion ||
        saved.vendor !== source.vendor || saved.category !== source.category ||
        saved.title !== source.title || saved.publisher !== source.publisher ||
        saved.source_url !== source.sourceUrl ||
        saved.retrieved_at.toISOString() !== source.retrievedAt ||
        saved.excerpt !== source.excerpt || saved.content_hash !== source.contentHash
      ) {
        throw new Error(`Source identity mismatch for ${source.id}`);
      }
      const ordinal = fixedCloudComparisonCorpus.findIndex((entry) => entry.id === source.id);
      await transaction.query(
        `INSERT INTO run_source_evidence
           (run_id, step_id, source_id, ordinal, evidence_hash)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (run_id, source_id) DO NOTHING`,
        [operation.runId, operation.operationId, source.id, ordinal, source.contentHash],
      );
    }
  });
}

function selectVendor(state: ReferenceState, vendor: CloudVendor): ReferenceState {
  const selected = fixedCloudComparisonCorpus.filter((source) => source.vendor === vendor);
  const existing = new Map(state.sourceSet.sources.map((source) => [source.id, source]));
  for (const source of selected) existing.set(source.id, source);
  return {
    ...state,
    sourceSet: {
      corpusVersion: cloudComparisonCorpusVersion,
      corpusHash: cloudComparisonCorpusHash,
      sources: [...existing.values()].sort((left, right) => left.id.localeCompare(right.id)),
    },
  };
}

function verifyFixedCorpus(state: ReferenceState): void {
  if (
    state.sourceSet.corpusVersion !== cloudComparisonCorpusVersion ||
    state.sourceSet.corpusHash !== cloudComparisonCorpusHash
  ) {
    throw new Error("Fixed evaluation corpus identity does not match");
  }
  for (const source of state.sourceSet.sources) {
    const { contentHash, ...snapshot } = source;
    if (contentHash !== fixedSourceContentHash(snapshot)) {
      throw new Error(`Fixed evaluation source hash does not match for ${source.id}`);
    }
  }
  const actual = state.sourceSet.sources
    .map((source) => ({ id: source.id, contentHash: source.contentHash }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const expected = fixedCloudComparisonCorpus
    .map((source) => ({ id: source.id, contentHash: source.contentHash }))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error("Fixed evaluation corpus is incomplete or contains unexpected evidence");
  }
}

function analysisContent(input: Record<string, unknown>, key: string): string {
  const analysis = asRecord(input[key], key);
  if (typeof analysis.content !== "string" || !analysis.content.trim()) {
    throw new Error(`${key}.content must be a non-empty string`);
  }
  return analysis.content.trim();
}

function reportFrom(state: ReferenceState): Record<string, unknown> {
  verifyFixedCorpus(state);
  const pricing = analysisContent(state, "pricingAnalysis");
  const features = analysisContent(state, "featureAnalysis");
  const target = typeof state.request.publicationTarget === "string"
    ? state.request.publicationTarget
    : "controlled://publications/cloud-comparison";
  if (!/^controlled:\/\/publications\/[a-z0-9][a-z0-9/_-]*$/.test(target)) {
    throw new Error("Reference publication target is not allowed");
  }
  const assumptions = state.request.assumptions ?? {
    scope: "Managed Kubernetes and supporting general-purpose compute",
    geography: "Representative US region; no cross-vendor SKU equivalence asserted",
    pricing: "No live price ranking; validate current SKU, region, storage, and network costs separately",
  };
  const citations = state.sourceSet.sources.map((source) => source.id).sort();
  const sourceLines = state.sourceSet.sources
    .map((source) => `- [${source.id}] ${source.title} — ${source.sourceUrl}`)
    .join("\n");
  const content = [
    "# Cloud comparison — fixed evaluation corpus",
    "",
    "> Evaluation artifact only. This report is not current purchasing guidance.",
    "",
    "## Assumptions",
    "",
    "```json",
    JSON.stringify(assumptions, null, 2),
    "```",
    "",
    "## Pricing analysis",
    "",
    pricing,
    "",
    "## Managed Kubernetes feature analysis",
    "",
    features,
    "",
    "## Sources",
    "",
    sourceLines,
    "",
  ].join("\n");
  const reportHash = sha256(content);
  return {
    report: {
      title: "Cloud comparison — fixed evaluation corpus",
      format: "text/markdown",
      content,
      sha256: reportHash,
      byteLength: Buffer.byteLength(content, "utf8"),
      citations,
    },
    publication: { target },
    sourceSet: {
      corpusVersion: state.sourceSet.corpusVersion,
      corpusHash: state.sourceSet.corpusHash,
      sourceCount: state.sourceSet.sources.length,
    },
    approvalBinding: {
      reportHash,
      publicationTarget: target,
      corpusHash: state.sourceSet.corpusHash,
      bindingHash: sha256(canonicalJson({ reportHash, publicationTarget: target, corpusHash: state.sourceSet.corpusHash })),
    },
  };
}

export function isReferenceDeterministicHandler(handler: string): boolean {
  return referenceHandlers.has(handler);
}

export async function executeReferenceDeterministicOperation(
  database: Database,
  operation: ReferenceOperation,
): Promise<Record<string, unknown>> {
  if (!isReferenceDeterministicHandler(operation.handler)) {
    throw new Error(`Unsupported reference handler: ${operation.handler}`);
  }
  const vendor = operation.handler === "select-aws-sources" ? "AWS"
    : operation.handler === "select-azure-sources" ? "AZURE"
      : operation.handler === "select-gcp-sources" ? "GCP" : null;
  if (vendor) await persistSourceEvidence(database, operation, fixedCloudComparisonCorpus.filter((source) => source.vendor === vendor));
  return executeReferenceTransform(operation.handler, operation.input);
}

// Shared pure operation body for matched volatile/reference experiments.
export function executeReferenceTransform(handler: string, input: Record<string, unknown>): Record<string, unknown> {
  if (!isReferenceDeterministicHandler(handler)) throw new Error(`Unsupported reference handler: ${handler}`);
  const state = stateFrom(input);
  const vendor = handler === "select-aws-sources" ? "AWS"
    : handler === "select-azure-sources" ? "AZURE"
      : handler === "select-gcp-sources" ? "GCP" : null;
  if (vendor) {
    return selectVendor(state, vendor);
  }
  if (handler === "collect-sources") {
    verifyFixedCorpus(state);
    return {
      ...state,
      sourceSet: {
        ...state.sourceSet,
        sources: [...state.sourceSet.sources].sort((left, right) => left.id.localeCompare(right.id)),
        sourceCount: fixedCloudComparisonCorpus.length,
        verified: true,
      },
    };
  }
  return reportFrom(state);
}
