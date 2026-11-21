import * as RadixSelect from "@radix-ui/react-select";
import { Check, ChevronDown, Loader2 } from "lucide-react";
import {
  forwardRef,
  useId,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react";
import { Tooltip } from "./overlays.js";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "sm" | "md";
  loading?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", loading = false, icon, children, className = "", disabled, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={`btn btn--${variant} btn--${size} ${className}`}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Loader2 size={16} className="spin" aria-hidden="true" /> : icon}
      {children && <span>{children}</span>}
    </button>
  );
});

/** Icon-only button. The label is both the accessible name and a tooltip. */
export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { label: string; size?: "sm" | "md" }>(
  function IconButton({ label, children, className = "", size = "md", type = "button", ...rest }, ref) {
    return (
      <Tooltip content={label}>
        <button ref={ref} type={type} className={`icon-btn icon-btn--${size} ${className}`} aria-label={label} {...rest}>
          {children}
        </button>
      </Tooltip>
    );
  },
);

export function Field({
  label, htmlFor, help, error, children, action,
}: { label: ReactNode; htmlFor: string; help?: ReactNode; error?: ReactNode; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="field">
      <div className="field-label-row">
        <label htmlFor={htmlFor}>{label}</label>
        {action}
      </div>
      {children}
      {error ? <span className="field-error" role="alert">{error}</span> : help ? <span className="field-help">{help}</span> : null}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { leading?: ReactNode; trailing?: ReactNode; invalid?: boolean }>(
  function Input({ leading, trailing, invalid, className = "", ...rest }, ref) {
    return (
      <div className={`input ${invalid ? "input--invalid" : ""} ${className}`}>
        {leading && <span className="input-adornment" aria-hidden="true">{leading}</span>}
        <input ref={ref} aria-invalid={invalid || undefined} {...rest} />
        {trailing && <span className="input-trailing">{trailing}</span>}
      </div>
    );
  },
);

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean; mono?: boolean }>(
  function Textarea({ invalid, mono, className = "", ...rest }, ref) {
    return <textarea ref={ref} className={`textarea ${mono ? "textarea--mono" : ""} ${invalid ? "textarea--invalid" : ""} ${className}`} aria-invalid={invalid || undefined} {...rest} />;
  },
);

export interface SelectOption { value: string; label: ReactNode; disabled?: boolean }

/** Accessible select (Radix): keyboard navigation, typeahead and screen-reader semantics included. */
export function Select({
  id, value, onChange, options, placeholder, label, size = "md", disabled,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly SelectOption[];
  placeholder?: string;
  /** Accessible name when there is no visible <label htmlFor>. */
  label?: string;
  size?: "sm" | "md";
  disabled?: boolean;
}) {
  const generated = useId();
  return (
    <RadixSelect.Root value={value} onValueChange={onChange} disabled={disabled ?? false}>
      <RadixSelect.Trigger id={id ?? generated} className={`select-trigger select-trigger--${size}`} aria-label={label}>
        <RadixSelect.Value placeholder={placeholder} />
        <RadixSelect.Icon className="select-icon"><ChevronDown size={16} /></RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        <RadixSelect.Content className="menu select-content" position="popper" sideOffset={4}>
          <RadixSelect.Viewport>
            {options.map((option) => (
              <RadixSelect.Item key={option.value} value={option.value} disabled={option.disabled ?? false} className="menu-item">
                <RadixSelect.ItemText>{option.label}</RadixSelect.ItemText>
                <RadixSelect.ItemIndicator className="menu-item-indicator"><Check size={16} /></RadixSelect.ItemIndicator>
              </RadixSelect.Item>
            ))}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  );
}

export function SegmentedControl<T extends string>({
  value, onChange, options, label,
}: { value: T; onChange: (value: T) => void; options: ReadonlyArray<{ value: T; label: ReactNode; help?: ReactNode }>; label: string }) {
  const name = useId();
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <label key={option.value} className={`segmented-option ${value === option.value ? "is-selected" : ""}`}>
          <input type="radio" name={name} value={option.value} checked={value === option.value} onChange={() => onChange(option.value)} />
          <span className="segmented-label">{option.label}</span>
          {option.help && <span className="segmented-help">{option.help}</span>}
        </label>
      ))}
    </div>
  );
}
