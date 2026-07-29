import type { ReactNode } from "react";

export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}

/** The consistent title bar at the top of every screen. */
export function PageHeader({ title, description, actions }: PageHeaderProps): JSX.Element {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "space-between",
        gap: "var(--space-4)",
        marginBottom: "var(--space-6)"
      }}
    >
      <div>
        <h1 style={{ fontSize: "20px", fontWeight: 650, color: "var(--color-text-primary)", letterSpacing: "-0.01em" }}>{title}</h1>
        {description && <p style={{ marginTop: "4px", fontSize: "13.5px", color: "var(--color-text-secondary)" }}>{description}</p>}
      </div>
      {actions && <div style={{ display: "flex", gap: "var(--space-2)", flexShrink: 0 }}>{actions}</div>}
    </div>
  );
}
