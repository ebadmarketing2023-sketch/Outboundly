import type { ReactNode } from "react";

export interface StatCardProps {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
}

/** A single metric tile, used on the Analytics dashboard and anywhere else a headline number
 * needs to stand out (health score, campaign counts). */
export function StatCard({ label, value, hint, icon }: StatCardProps): JSX.Element {
  return (
    <div
      style={{
        background: "var(--color-surface)",
        border: "1px solid var(--color-border)",
        borderRadius: "var(--radius-lg)",
        padding: "var(--space-5)",
        display: "flex",
        flexDirection: "column",
        gap: "6px",
        minWidth: 0
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", color: "var(--color-text-secondary)" }}>
        {icon}
        <span style={{ fontSize: "12.5px", fontWeight: 600 }}>{label}</span>
      </div>
      <div style={{ fontSize: "24px", fontWeight: 650, color: "var(--color-text-primary)", letterSpacing: "-0.01em" }}>{value}</div>
      {hint && <div style={{ fontSize: "12px", color: "var(--color-text-tertiary)" }}>{hint}</div>}
    </div>
  );
}
