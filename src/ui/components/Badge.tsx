import type { ReactNode } from "react";

export type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info" | "primary";

const TONE_STYLE: Record<BadgeTone, { bg: string; color: string; border: string }> = {
  neutral: { bg: "var(--color-surface-hover)", color: "var(--color-text-secondary)", border: "var(--color-border)" },
  success: { bg: "var(--color-success-bg)", color: "var(--color-success)", border: "var(--color-success-border)" },
  warning: { bg: "var(--color-warning-bg)", color: "var(--color-warning)", border: "var(--color-warning-border)" },
  danger: { bg: "var(--color-danger-bg)", color: "var(--color-danger)", border: "var(--color-danger-border)" },
  info: { bg: "var(--color-info-bg)", color: "var(--color-info)", border: "var(--color-info-border)" },
  primary: { bg: "var(--color-primary-light)", color: "var(--color-primary)", border: "var(--color-primary-border)" }
};

export interface BadgeProps {
  tone?: BadgeTone;
  children: ReactNode;
  icon?: ReactNode;
}

/** A small pill used for statuses/severities (campaign status, enrollment status, insight
 * severity, account connection state) so the same concept always looks the same everywhere. */
export function Badge({ tone = "neutral", children, icon }: BadgeProps): JSX.Element {
  const t = TONE_STYLE[tone];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.3rem",
        padding: "2px 9px",
        borderRadius: "var(--radius-full)",
        fontSize: "12px",
        fontWeight: 600,
        lineHeight: "18px",
        background: t.bg,
        color: t.color,
        border: `1px solid ${t.border}`,
        whiteSpace: "nowrap"
      }}
    >
      {icon}
      {children}
    </span>
  );
}

const CAMPAIGN_STATUS_TONE: Record<string, BadgeTone> = {
  draft: "neutral",
  running: "success",
  paused: "warning",
  completed: "info"
};

const ENROLLMENT_STATUS_TONE: Record<string, BadgeTone> = {
  active: "success",
  completed: "info",
  stopped_reply: "primary",
  stopped_bounce: "danger",
  stopped_manual: "neutral",
  stopped_suppressed: "warning"
};

const ACCOUNT_STATUS_TONE: Record<string, BadgeTone> = {
  connected: "success",
  reauth_required: "warning",
  disconnected: "neutral"
};

const SEVERITY_TONE: Record<string, BadgeTone> = {
  info: "info",
  warning: "warning",
  critical: "danger"
};

function humanize(value: string): string {
  return value
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function StatusBadge({ status }: { status: string }): JSX.Element {
  return <Badge tone={CAMPAIGN_STATUS_TONE[status] ?? "neutral"}>{humanize(status)}</Badge>;
}

export function EnrollmentStatusBadge({ status }: { status: string }): JSX.Element {
  return <Badge tone={ENROLLMENT_STATUS_TONE[status] ?? "neutral"}>{humanize(status)}</Badge>;
}

export function AccountStatusBadge({ status }: { status: string }): JSX.Element {
  return <Badge tone={ACCOUNT_STATUS_TONE[status] ?? "neutral"}>{humanize(status)}</Badge>;
}

export function SeverityBadge({ severity }: { severity: string }): JSX.Element {
  return <Badge tone={SEVERITY_TONE[severity] ?? "neutral"}>{humanize(severity)}</Badge>;
}
