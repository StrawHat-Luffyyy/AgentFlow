import { AlertTriangle, Loader2 } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from "react";

export type Tone = "success" | "warning" | "danger" | "running" | "waiting" | "neutral";

const toneByStatus: Record<string, Tone> = {
  SUCCEEDED: "success",
  APPROVED: "success",
  FAILED: "danger",
  TIMED_OUT: "danger",
  REJECTED: "danger",
  EXPIRED: "danger",
  RUNNING: "running",
  WAITING_APPROVAL: "waiting",
  QUEUED: "waiting",
  READY: "waiting",
  PENDING: "waiting",
  RETRY_WAIT: "warning",
  NEEDS_ATTENTION: "warning",
  UNKNOWN: "warning",
  PAUSED: "warning",
  PAUSE_REQUESTED: "warning",
  CANCEL_REQUESTED: "warning",
  ABANDONED: "warning",
};

export function statusTone(status: string): Tone {
  return toneByStatus[status] ?? "neutral";
}

/** Converts persisted enum values such as WAITING_APPROVAL into "Waiting approval". */
export function humanize(value: string): string {
  const words = value.toLowerCase().replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function StatusBadge({ value, size = "md" }: { value: string; size?: "sm" | "md" }) {
  const tone = statusTone(value);
  return (
    <span className={`badge badge--${tone} badge--${size}`} title={value}>
      <span className="badge-dot" aria-hidden="true" />
      {humanize(value)}
    </span>
  );
}

type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  icon,
  children,
  className = "",
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: "sm" | "md" | "lg";
  loading?: boolean;
  icon?: ReactNode;
}) {
  return (
    <button
      className={`btn btn--${variant} btn--${size} ${className}`}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Loader2 size={14} className="spin" aria-hidden="true" /> : icon}
      {children}
    </button>
  );
}

/** Icon-only button; the accessible label doubles as a hover tooltip. */
export function IconButton({
  label,
  children,
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button className={`icon-btn ${className}`} aria-label={label} data-tooltip={label} {...rest}>
      {children}
    </button>
  );
}

export function Panel({
  title,
  meta,
  actions,
  tone,
  children,
  className = "",
  labelledBy,
}: {
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  tone?: "warning";
  children: ReactNode;
  className?: string;
  labelledBy?: string;
}) {
  const generated = useId();
  const headingId = labelledBy ?? generated;
  return (
    <section className={`panel ${tone ? `panel--${tone}` : ""} ${className}`} aria-labelledby={headingId}>
      <header className="panel-header">
        <div className="panel-title">
          <h3 id={headingId}>{title}</h3>
          {meta && <span className="panel-meta">{meta}</span>}
        </div>
        {actions && <div className="panel-actions">{actions}</div>}
      </header>
      {children}
    </section>
  );
}

export function EmptyState({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty-state">
      {icon && <span className="empty-state-icon" aria-hidden="true">{icon}</span>}
      <strong>{title}</strong>
      {children && <p>{children}</p>}
    </div>
  );
}

export function InlineAlert({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="alert" role="alert">
      <AlertTriangle size={15} aria-hidden="true" />
      <span className="alert-body">{children}</span>
      {action}
    </div>
  );
}

export function ProgressBar({ value, total, label, tone }: { value: number; total: number; label: string; tone?: Tone }) {
  const percent = total === 0 ? 0 : Math.round((value / total) * 100);
  return (
    <div
      className={`progress ${tone ? `progress--${tone}` : ""}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={value}
      aria-valuetext={`${value} of ${total}`}
    >
      <span className="progress-fill" style={{ width: `${percent}%` }} />
    </div>
  );
}

export function Skeleton({ width = "100%", height = 12 }: { width?: number | string; height?: number }) {
  return <span className="skeleton" style={{ width, height }} aria-hidden="true" />;
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
  idPrefix,
}: {
  tabs: readonly T[];
  value: T;
  onChange: (tab: T) => void;
  label: string;
  idPrefix: string;
}) {
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const offset = event.key === "ArrowRight" ? 1 : -1;
    const next = tabs[(tabs.indexOf(value) + offset + tabs.length) % tabs.length]!;
    onChange(next);
    document.getElementById(`${idPrefix}-tab-${next}`)?.focus();
  }
  return (
    <div className="tabs" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {tabs.map((tab) => (
        <button
          key={tab}
          id={`${idPrefix}-tab-${tab}`}
          role="tab"
          type="button"
          aria-selected={value === tab}
          aria-controls={`${idPrefix}-panel`}
          tabIndex={value === tab ? 0 : -1}
          onClick={() => onChange(tab)}
        >
          {humanize(tab)}
        </button>
      ))}
    </div>
  );
}

/** Modal confirmation built on the native dialog element (focus trap and Escape handling included). */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  dismissLabel,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  dismissLabel: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);
  return (
    <dialog
      ref={dialog}
      className="dialog"
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(event) => { if (event.target === dialog.current) onClose(); }}
    >
      <div className="dialog-body">
        <h2 id={titleId}>{title}</h2>
        <div className="dialog-content">{children}</div>
      </div>
      <footer className="dialog-footer">
        <Button variant="secondary" onClick={onClose} autoFocus>{dismissLabel}</Button>
        <Button variant="danger" onClick={() => { onConfirm(); onClose(); }}>{confirmLabel}</Button>
      </footer>
    </dialog>
  );
}

export function BrandMark({ size = 24 }: { size?: number }) {
  return (
    <span className="brand-mark" style={{ width: size, height: size }} aria-hidden="true">
      <svg width={size * 0.6} height={size * 0.6} viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2 2 7l10 5 10-5-10-5Z" />
        <path d="m2 17 10 5 10-5" />
        <path d="m2 12 10 5 10-5" />
      </svg>
    </span>
  );
}
