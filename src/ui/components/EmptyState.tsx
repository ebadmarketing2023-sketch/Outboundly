import type { ReactNode } from "react";

export interface EmptyStateProps {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}

/** Consistent "nothing here yet" treatment, used instead of a bare "No X yet." line of text. */
export function EmptyState({ icon, title, description, action }: EmptyStateProps): JSX.Element {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        textAlign: "center",
        padding: "var(--space-10) var(--space-6)",
        color: "var(--color-text-secondary)"
      }}
    >
      {icon && (
        <div
          style={{
            width: 44,
            height: 44,
            borderRadius: "var(--radius-full)",
            background: "var(--color-primary-light)",
            color: "var(--color-primary)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            marginBottom: "var(--space-4)"
          }}
        >
          {icon}
        </div>
      )}
      <h3 style={{ fontSize: "14px", fontWeight: 600, color: "var(--color-text-primary)" }}>{title}</h3>
      {description && <p style={{ marginTop: "4px", fontSize: "13px", maxWidth: 360 }}>{description}</p>}
      {action && <div style={{ marginTop: "var(--space-4)" }}>{action}</div>}
    </div>
  );
}
