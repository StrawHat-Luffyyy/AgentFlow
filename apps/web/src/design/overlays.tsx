import * as RadixDialog from "@radix-ui/react-dialog";
import * as RadixTabs from "@radix-ui/react-tabs";
import * as RadixTooltip from "@radix-ui/react-tooltip";
import { CheckCircle2, AlertTriangle, Info, X } from "lucide-react";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";

/* ------------------------------------------------------------------ Tooltip */
export function Tooltip({ content, children, side = "top" }: { content: ReactNode; children: ReactElement; side?: "top" | "bottom" | "left" | "right" }) {
  return (
    <RadixTooltip.Root delayDuration={400}>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content className="tooltip" side={side} sideOffset={6}>{content}</RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}

export const TooltipProvider = RadixTooltip.Provider;

/* ------------------------------------------------------------------- Dialog */
export function Dialog({
  open, onOpenChange, title, description, children, footer, size = "md",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: "md" | "lg";
}) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="dialog-overlay" />
        {/* Without a description, opt out of aria-describedby explicitly (Radix requirement). */}
        <RadixDialog.Content className={`dialog dialog--${size}`} {...(description ? {} : { "aria-describedby": undefined })}>
          <header className="dialog-header">
            <RadixDialog.Title className="dialog-title">{title}</RadixDialog.Title>
            <RadixDialog.Close className="icon-btn icon-btn--sm" aria-label="Close"><X size={16} /></RadixDialog.Close>
          </header>
          {description && <RadixDialog.Description className="dialog-description">{description}</RadixDialog.Description>}
          {children && <div className="dialog-body">{children}</div>}
          {footer && <footer className="dialog-footer">{footer}</footer>}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

export const DialogClose = RadixDialog.Close;

/* --------------------------------------------------------------------- Tabs */
export function Tabs<T extends string>({
  value, onChange, tabs, label, children,
}: {
  value: T;
  onChange: (value: T) => void;
  tabs: ReadonlyArray<{ value: T; label: ReactNode; count?: number }>;
  label: string;
  children: ReactNode;
}) {
  return (
    <RadixTabs.Root value={value} onValueChange={(next) => onChange(next as T)} className="tabs">
      <RadixTabs.List className="tabs-list" aria-label={label}>
        {tabs.map((tab) => (
          <RadixTabs.Trigger key={tab.value} value={tab.value} className="tabs-trigger">
            {tab.label}
            {tab.count !== undefined && <span className="tabs-count">{tab.count}</span>}
          </RadixTabs.Trigger>
        ))}
      </RadixTabs.List>
      {children}
    </RadixTabs.Root>
  );
}

export function TabPanel({ value, children }: { value: string; children: ReactNode }) {
  return <RadixTabs.Content value={value} className="tabs-panel">{children}</RadixTabs.Content>;
}

/* -------------------------------------------------------------------- Toast */
type ToastTone = "success" | "danger" | "info";
interface ToastItem { id: number; tone: ToastTone; title: string; description?: string }
interface ToastApi { show: (toast: Omit<ToastItem, "id">) => void }

const ToastContext = createContext<ToastApi | null>(null);

/** Small toast stack announced through an aria-live region; toasts dismiss themselves after 5s. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const next = useRef(1);
  const dismiss = useCallback((id: number) => setToasts((items) => items.filter((item) => item.id !== id)), []);
  const show = useCallback((toast: Omit<ToastItem, "id">) => {
    const id = next.current++;
    setToasts((items) => [...items.slice(-3), { ...toast, id }]);
    window.setTimeout(() => dismiss(id), 5_000);
  }, [dismiss]);
  const api = useMemo(() => ({ show }), [show]);
  const icon = { success: <CheckCircle2 size={16} />, danger: <AlertTriangle size={16} />, info: <Info size={16} /> };
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-region" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast--${toast.tone}`}>
            <span className="toast-icon" aria-hidden="true">{icon[toast.tone]}</span>
            <div className="toast-body">
              <strong>{toast.title}</strong>
              {toast.description && <span>{toast.description}</span>}
            </div>
            <button type="button" className="icon-btn icon-btn--sm" aria-label="Dismiss notification" onClick={() => dismiss(toast.id)}><X size={16} /></button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const value = useContext(ToastContext);
  if (!value) throw new Error("useToast must be used inside ToastProvider");
  return value;
}
