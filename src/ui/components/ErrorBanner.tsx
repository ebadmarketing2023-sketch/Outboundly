import { AlertTriangleIcon } from "./Icons.js";

export interface ErrorBannerProps {
  message: string;
}

/** A page-level error banner for a failed initial data load (as opposed to a transient toast for
 * a failed action) -- used consistently instead of ad-hoc red paragraph text. */
export function ErrorBanner({ message }: ErrorBannerProps): JSX.Element {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: "0.6rem",
        background: "var(--color-danger-bg)",
        border: "1px solid var(--color-danger-border)",
        color: "var(--color-danger)",
        borderRadius: "var(--radius-md)",
        padding: "12px 14px",
        fontSize: "13px",
        marginBottom: "var(--space-5)",
        whiteSpace: "pre-wrap"
      }}
    >
      <AlertTriangleIcon size={16} style={{ marginTop: 1, flexShrink: 0 }} />
      <span>{message}</span>
    </div>
  );
}
