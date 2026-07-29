import {
  forwardRef,
  type CSSProperties,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes
} from "react";

const controlStyle: CSSProperties = {
  width: "100%",
  padding: "8px 11px",
  fontSize: "13.5px",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--color-border-strong)",
  background: "var(--color-surface)",
  color: "var(--color-text-primary)"
};

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { style, ...rest },
  ref
) {
  return <input ref={ref} style={{ ...controlStyle, ...style }} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { style, children, ...rest },
  ref
) {
  return (
    <select ref={ref} style={{ ...controlStyle, cursor: "pointer", ...style }} {...rest}>
      {children}
    </select>
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { style, ...rest },
  ref
) {
  return <textarea ref={ref} style={{ ...controlStyle, resize: "vertical", fontFamily: "inherit", ...style }} {...rest} />;
});

export interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  disabled?: boolean;
}

export function Checkbox({ checked, onChange, label, disabled }: CheckboxProps): JSX.Element {
  return (
    <label
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.4rem",
        fontSize: "13.5px",
        color: "var(--color-text-primary)",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.6 : 1
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        style={{ width: 15, height: 15, accentColor: "var(--color-primary)" }}
      />
      {label}
    </label>
  );
}

export interface FieldProps {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  htmlFor?: string;
}

/** Consistent label + control + hint stack used for every form field in the app. */
export function Field({ label, hint, children, htmlFor }: FieldProps): JSX.Element {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
      <label htmlFor={htmlFor} style={{ fontSize: "12.5px", fontWeight: 600, color: "var(--color-text-secondary)" }}>
        {label}
      </label>
      {children}
      {hint && <span style={{ fontSize: "12px", color: "var(--color-text-tertiary)" }}>{hint}</span>}
    </div>
  );
}
