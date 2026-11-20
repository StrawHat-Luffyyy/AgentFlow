import { AlertTriangle, Check, Copy, RotateCw } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { humanize } from "../lib/format.js";
import { Button } from "./controls.js";
import { statusTone, type Tone } from "./status.js";

/* ------------------------------------------------------------------- Badges */
export function StatusPill({ value, size = "md" }: { value: string; size?: "sm" | "md" }) {
  const tone = statusTone(value);
  return (
    <span className={`pill pill--${tone} pill--${size}`} title={value}>
      <span className={`pill-dot ${value === "RUNNING" ? "pill-dot--pulse" : ""}`} aria-hidden="true" />
      {humanize(value)}
    </span>
  );
}

export function Badge({ tone = "neutral", children, title }: { tone?: Tone | "accent"; children: ReactNode; title?: string }) {
  return <span className={`badge badge--${tone}`} title={title}>{children}</span>;
}

/** Quiet uppercase label, e.g. a step type. */
export function Tag({ children }: { children: ReactNode }) {
  return <span className="tag">{children}</span>;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

/* -------------------------------------------------------------------- Cards */
export function Card({
  title, meta, actions, children, className = "", padded = true, id,
}: { title?: ReactNode; meta?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; padded?: boolean; id?: string }) {
  return (
    <section className={`card ${className}`} aria-labelledby={title && id ? `${id}-title` : undefined}>
      {(title || actions) && (
        <header className="card-header">
          <div className="card-heading">
            {title && <h2 id={id ? `${id}-title` : undefined} className="card-title">{title}</h2>}
            {meta && <span className="card-meta">{meta}</span>}
          </div>
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      <div className={padded ? "card-body" : "card-body card-body--flush"}>{children}</div>
    </section>
  );
}

export function KeyValue({ items, columns = 1 }: { items: ReadonlyArray<{ label: ReactNode; value: ReactNode; mono?: boolean }>; columns?: 1 | 2 | 3 }) {
  return (
    <dl className={`kv kv--cols-${columns}`}>
      {items.map((item, index) => (
        <div className="kv-row" key={index}>
          <dt>{item.label}</dt>
          <dd className={item.mono ? "mono" : undefined}>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/* ----------------------------------------------------------------- Feedback */
export function Skeleton({ width = "100%", height = 12, radius }: { width?: number | string; height?: number; radius?: number }) {
  return <span className="skeleton" style={{ width, height, borderRadius: radius }} aria-hidden="true" />;
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty-state">
      {icon && <span className="empty-state-icon" aria-hidden="true">{icon}</span>}
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function ErrorState({ title = "Something went wrong", message, onRetry }: { title?: string; message: string; onRetry?: () => void }) {
  return (
    <div className="empty-state empty-state--error" role="alert">
      <span className="empty-state-icon" aria-hidden="true"><AlertTriangle size={20} /></span>
      <h3>{title}</h3>
      <p>{message}</p>
      {onRetry && <Button size="sm" icon={<RotateCw size={16} />} onClick={onRetry}>Retry</Button>}
    </div>
  );
}

export function InlineAlert({ tone = "danger", children, action }: { tone?: "danger" | "warning" | "info"; children: ReactNode; action?: ReactNode }) {
  return (
    <div className={`alert alert--${tone}`} role={tone === "danger" ? "alert" : "status"}>
      <AlertTriangle size={16} aria-hidden="true" />
      <div className="alert-body">{children}</div>
      {action}
    </div>
  );
}

export function ProgressBar({ value, total, label, tone = "info" }: { value: number; total: number; label: string; tone?: Tone }) {
  const percent = total === 0 ? 0 : Math.min(100, Math.round((value / total) * 100));
  return (
    <div className={`progress progress--${tone}`} role="progressbar" aria-label={label}
      aria-valuemin={0} aria-valuemax={total} aria-valuenow={value} aria-valuetext={`${value} of ${total}`}>
      <span className="progress-fill" style={{ width: `${percent}%` }} />
    </div>
  );
}

/* ---------------------------------------------------------------- CodeBlock */
export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      className="copy-btn"
      aria-label={copied ? "Copied" : label}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setCopied(false), 1_500);
        });
      }}
    >
      {copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
    </button>
  );
}

export function CodeBlock({ value, empty = "Nothing recorded.", maxHeight = 420, label }: { value: unknown; empty?: string; maxHeight?: number; label?: string }) {
  if (value === null || value === undefined) return <p className="muted-inline">{empty}</p>;
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return (
    <div className="code-block">
      <div className="code-block-toolbar">
        {label && <span className="code-block-label">{label}</span>}
        <CopyButton text={text} label="Copy to clipboard" />
      </div>
      <pre tabIndex={0} style={{ maxHeight }}>{text}</pre>
    </div>
  );
}

/** Monospace identifier with a copy affordance, e.g. a run ID or a hash. */
export function IdChip({ value, display }: { value: string; display?: string }) {
  return (
    <span className="id-chip">
      <code title={value}>{display ?? value}</code>
      <CopyButton text={value} label={`Copy ${value}`} />
    </span>
  );
}

/* ----------------------------------------------------------------- Timeline */
export interface TimelineItem {
  id: string;
  tone: Tone;
  title: ReactNode;
  meta?: ReactNode;
  detail?: ReactNode;
  selected?: boolean;
  onSelect?: () => void;
}

export function Timeline({ items, label }: { items: readonly TimelineItem[]; label: string }) {
  return (
    <ol className="timeline" aria-label={label}>
      {items.map((item) => {
        const body = (
          <>
            <span className={`timeline-marker timeline-marker--${item.tone}`} aria-hidden="true" />
            <span className="timeline-content">
              <span className="timeline-title">{item.title}</span>
              {item.meta && <span className="timeline-meta">{item.meta}</span>}
              {item.detail && <span className="timeline-detail">{item.detail}</span>}
            </span>
          </>
        );
        return (
          <li key={item.id} className={`timeline-item ${item.selected ? "is-selected" : ""}`}>
            {item.onSelect
              ? <button type="button" className="timeline-button" aria-current={item.selected ? "step" : undefined} onClick={item.onSelect}>{body}</button>
              : <div className="timeline-button timeline-button--static">{body}</div>}
          </li>
        );
      })}
    </ol>
  );
}

/* -------------------------------------------------------------------- Brand */
export function BrandMark({ size = 22 }: { size?: number }) {
  return (
    <span className="brand-mark" style={{ width: size, height: size }} aria-hidden="true">
      <svg width={size * 0.62} height={size * 0.62} viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2 2 7l10 5 10-5-10-5Z" />
        <path d="m2 17 10 5 10-5" />
        <path d="m2 12 10 5 10-5" />
      </svg>
    </span>
  );
}
