import type { CSSProperties, ReactNode } from "react";

export interface CardProps {
  children: ReactNode;
  style?: CSSProperties;
  padding?: "none" | "sm" | "md";
}

/** The base surface every panel/section in the app sits on. */
export function Card({ children, style, padding = "md" }: CardProps): JSX.Element {
  return (
    <div
      style={{
        background: "var(--color-surface)",
        border: "1px solid var(--color-border)",
        borderRadius: "var(--radius-lg)",
        boxShadow: "var(--shadow-sm)",
        padding: padding === "none" ? 0 : padding === "sm" ? "var(--space-4)" : "var(--space-6)",
        ...style
      }}
    >
      {children}
    </div>
  );
}

export interface CardHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}

export function CardHeader({ title, description, actions }: CardHeaderProps): JSX.Element {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "space-between",
        gap: "var(--space-4)",
        marginBottom: "var(--space-5)"
      }}
    >
      <div>
        <h2 style={{ fontSize: "15px", fontWeight: 600, color: "var(--color-text-primary)" }}>{title}</h2>
        {description && (
          <p style={{ marginTop: "4px", fontSize: "13px", color: "var(--color-text-secondary)" }}>{description}</p>
        )}
      </div>
      {actions && <div style={{ display: "flex", gap: "var(--space-2)", flexShrink: 0 }}>{actions}</div>}
    </div>
  );
}
