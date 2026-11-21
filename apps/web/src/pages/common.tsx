import { Bot, Cog, FileCheck2, Send, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { Badge, Tooltip } from "../design/index.js";
import { liveProviderLabel, runMode } from "../new-run.js";

/** "Scripted" vs "Live · Gemini", so evaluation runs and real-provider runs are never confused. */
export function ProviderBadge({ providers }: { providers: string[] | undefined }) {
  const mode = runMode(providers);
  if (mode.kind === "none") return <span className="muted">—</span>;
  if (mode.kind === "scripted") {
    return (
      <Tooltip content="Deterministic evaluation provider: no API key, no cost; token counts are estimates">
        <span tabIndex={0}><Badge tone="neutral">Scripted</Badge></span>
      </Tooltip>
    );
  }
  return (
    <Tooltip content={`Real provider calls via ${mode.provider}; tokens are billed`}>
      <span tabIndex={0}><Badge tone="accent"><Sparkles size={12} aria-hidden="true" />{liveProviderLabel(mode.provider)}</Badge></span>
    </Tooltip>
  );
}

const stepTypes: Record<string, { label: string; icon: ReactNode }> = {
  DETERMINISTIC: { label: "Deterministic", icon: <Cog size={16} /> },
  AGENT: { label: "Agent", icon: <Bot size={16} /> },
  APPROVAL: { label: "Approval", icon: <FileCheck2 size={16} /> },
  TOOL: { label: "Side effect", icon: <Send size={16} /> },
};

export function stepType(kind: string): { label: string; icon: ReactNode } {
  return stepTypes[kind] ?? { label: kind, icon: <Cog size={16} /> };
}

export function PageHeader({ title, description, actions, meta }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; meta?: ReactNode }) {
  return (
    <header className="page-header">
      <div className="page-heading">
        <h1>{title}</h1>
        {description && <p className="page-description">{description}</p>}
        {meta && <div className="page-meta">{meta}</div>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

/** Live/updated/stale indicator for polled data; reserves its width so nothing shifts. */
export function LiveIndicator({ updatedAt, refreshing, error, now }: { updatedAt: number | null; refreshing: boolean; error: string | null; now: number }) {
  const stale = error !== null && updatedAt !== null;
  const seconds = updatedAt === null ? null : Math.max(0, Math.round((now - updatedAt) / 1_000));
  const text = stale ? "Connection lost · showing last data" : updatedAt === null ? "Connecting…" : seconds! < 3 ? "Live" : `Updated ${seconds}s ago`;
  return (
    <span className={`live ${stale ? "live--stale" : ""} ${refreshing ? "live--refreshing" : ""}`} role="status" aria-live="polite">
      <span className="live-dot" aria-hidden="true" />
      {text}
    </span>
  );
}
