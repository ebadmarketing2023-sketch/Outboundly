import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Spinner } from "./Spinner.js";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "danger-ghost";
export type ButtonSize = "sm" | "md";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
  fullWidth?: boolean;
}

const VARIANT_STYLE: Record<ButtonVariant, { bg: string; bgHover: string; color: string; border: string }> = {
  primary: { bg: "var(--color-primary)", bgHover: "var(--color-primary-hover)", color: "var(--color-text-inverse)", border: "transparent" },
  secondary: { bg: "var(--color-surface)", bgHover: "var(--color-surface-hover)", color: "var(--color-text-primary)", border: "var(--color-border-strong)" },
  ghost: { bg: "transparent", bgHover: "var(--color-surface-hover)", color: "var(--color-text-secondary)", border: "transparent" },
  danger: { bg: "var(--color-danger)", bgHover: "#912018", color: "#ffffff", border: "transparent" },
  "danger-ghost": { bg: "transparent", bgHover: "var(--color-danger-bg)", color: "var(--color-danger)", border: "transparent" }
};

/** Base button used everywhere in the app so every action has the same size, focus ring, hover,
 * and disabled/loading treatment. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", loading = false, icon, fullWidth, disabled, children, style, className, ...rest },
  ref
) {
  const v = VARIANT_STYLE[variant];
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={className}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "0.4rem",
        width: fullWidth ? "100%" : undefined,
        padding: size === "sm" ? "5px 10px" : "8px 14px",
        fontSize: size === "sm" ? "12.5px" : "13.5px",
        fontWeight: 500,
        borderRadius: "var(--radius-md)",
        border: `1px solid ${v.border}`,
        background: v.bg,
        color: v.color,
        cursor: disabled || loading ? "not-allowed" : "pointer",
        opacity: disabled && !loading ? 0.55 : 1,
        transition: "background-color 120ms ease, border-color 120ms ease",
        whiteSpace: "nowrap",
        ...style
      }}
      onMouseEnter={(e) => {
        if (!disabled && !loading) e.currentTarget.style.background = v.bgHover;
      }}
      onMouseLeave={(e) => {
        if (!disabled && !loading) e.currentTarget.style.background = v.bg;
      }}
      {...rest}
    >
      {loading ? <Spinner size={size === "sm" ? 12 : 14} color={variant === "primary" || variant === "danger" ? "#fff" : undefined} /> : icon}
      {children}
    </button>
  );
});
