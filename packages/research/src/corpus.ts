import { createHash } from "node:crypto";
import { canonicalJson } from "@agentflow/shared";

export const cloudComparisonCorpusVersion = "cloud-comparison-2026-09-30.v1";
export const cloudComparisonCorpusRetrievedAt = "2026-09-30T00:00:00.000Z";

export type CloudVendor = "AWS" | "AZURE" | "GCP";
export type EvidenceCategory = "PRICING" | "MANAGED_KUBERNETES";

export interface FixedSourceDocument {
  id: string;
  corpusVersion: string;
  vendor: CloudVendor;
  category: EvidenceCategory;
  title: string;
  publisher: string;
  sourceUrl: string;
  retrievedAt: string;
  excerpt: string;
  contentHash: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function fixedSourceContentHash(
  source: Omit<FixedSourceDocument, "contentHash">,
): string {
  return sha256(canonicalJson({
    id: source.id,
    corpusVersion: source.corpusVersion,
    vendor: source.vendor,
    category: source.category,
    title: source.title,
    publisher: source.publisher,
    sourceUrl: source.sourceUrl,
    retrievedAt: source.retrievedAt,
    excerpt: source.excerpt,
  }));
}

const sourceInputs: Array<Omit<FixedSourceDocument, "corpusVersion" | "retrievedAt" | "contentHash">> = [
  {
    id: "aws-ec2-pricing",
    vendor: "AWS",
    category: "PRICING",
    title: "Amazon EC2 On-Demand Pricing",
    publisher: "Amazon Web Services",
    sourceUrl: "https://aws.amazon.com/ec2/pricing/on-demand/",
    excerpt: "EC2 On-Demand capacity is billed without a long-term commitment; operating system, region, storage, networking, and other attached services can change the total workload cost.",
  },
  {
    id: "aws-eks-overview",
    vendor: "AWS",
    category: "MANAGED_KUBERNETES",
    title: "What is Amazon EKS?",
    publisher: "Amazon Web Services",
    sourceUrl: "https://docs.aws.amazon.com/eks/latest/userguide/what-is-eks.html",
    excerpt: "Amazon EKS manages the Kubernetes control plane and offers standard and more automated operating modes; worker compute and supporting AWS resources remain separately relevant to cost and operations.",
  },
  {
    id: "azure-vm-pricing",
    vendor: "AZURE",
    category: "PRICING",
    title: "Linux Virtual Machines pricing",
    publisher: "Microsoft Azure",
    sourceUrl: "https://azure.microsoft.com/en-us/pricing/details/virtual-machines/linux/",
    excerpt: "Azure virtual-machine estimates depend on VM series and size, region, operating system, purchase option, storage, and networking; a workload comparison must hold those assumptions constant.",
  },
  {
    id: "azure-aks-overview",
    vendor: "AZURE",
    category: "MANAGED_KUBERNETES",
    title: "Azure Kubernetes Service core concepts",
    publisher: "Microsoft",
    sourceUrl: "https://learn.microsoft.com/en-us/azure/aks/core-aks-concepts",
    excerpt: "AKS is a managed Kubernetes service with Azure-managed control-plane components and VM-backed nodes, with Automatic and Standard modes offering different balances of defaults and operator control.",
  },
  {
    id: "gcp-compute-pricing",
    vendor: "GCP",
    category: "PRICING",
    title: "Compute Engine virtual machines pricing",
    publisher: "Google Cloud",
    sourceUrl: "https://cloud.google.com/products/compute/pricing",
    excerpt: "Compute Engine pricing accounts for vCPU, memory, machine family, region, storage, and network usage; discount eligibility and billing rules must be treated separately from raw on-demand rates.",
  },
  {
    id: "gcp-gke-overview",
    vendor: "GCP",
    category: "MANAGED_KUBERNETES",
    title: "Google Kubernetes Engine overview",
    publisher: "Google Cloud",
    sourceUrl: "https://docs.cloud.google.com/kubernetes-engine/docs/concepts/kubernetes-engine-overview",
    excerpt: "GKE provides managed Kubernetes with Standard and Autopilot modes; the modes differ in infrastructure control, node management, scaling defaults, and which resources form the billing basis.",
  },
];

export const fixedCloudComparisonCorpus: readonly FixedSourceDocument[] = sourceInputs.map((source) => {
  const snapshot = {
    ...source,
    corpusVersion: cloudComparisonCorpusVersion,
    retrievedAt: cloudComparisonCorpusRetrievedAt,
  };
  return { ...snapshot, contentHash: fixedSourceContentHash(snapshot) };
});

export const cloudComparisonCorpusHash = sha256(canonicalJson({
  version: cloudComparisonCorpusVersion,
  sources: fixedCloudComparisonCorpus.map((source) => ({
    id: source.id,
    sourceUrl: source.sourceUrl,
    contentHash: source.contentHash,
  })),
}));

export const cloudComparisonCorpusManifest = {
  name: "AgentFlow fixed cloud-comparison evaluation corpus",
  version: cloudComparisonCorpusVersion,
  retrievedAt: cloudComparisonCorpusRetrievedAt,
  corpusHash: cloudComparisonCorpusHash,
  purpose: "Reproducible reliability evaluation; not current purchasing guidance.",
  sources: fixedCloudComparisonCorpus,
} as const;
