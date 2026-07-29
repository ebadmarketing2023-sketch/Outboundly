export interface SpinnerProps {
  size?: number;
  color?: string;
}

/** A single reusable loading indicator so every screen's "loading" state looks identical. */
export function Spinner({ size = 16, color }: SpinnerProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      style={{ animation: "ob-spin 0.7s linear infinite", flexShrink: 0 }}
    >
      <circle cx="12" cy="12" r="9.5" stroke={color ?? "var(--color-border-strong)"} strokeWidth="2.5" opacity="0.4" />
      <path d="M21.5 12a9.5 9.5 0 0 0-9.5-9.5" stroke={color ?? "var(--color-primary)"} strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}
