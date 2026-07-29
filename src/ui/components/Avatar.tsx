const PALETTE = ["#4f46e5", "#0891b2", "#b45309", "#be185d", "#15803d", "#7c3aed", "#c2410c"];

function hashColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return PALETTE[hash % PALETTE.length]!;
}

function initials(seed: string): string {
  const trimmed = seed.trim();
  if (!trimmed) return "?";
  const parts = trimmed.split(/[\s@.]+/).filter(Boolean);
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
}

export interface AvatarProps {
  name: string;
  size?: number;
}

/** A small colored initials circle for accounts/contacts, so a list of email addresses isn't just
 * a wall of plain text. */
export function Avatar({ name, size = 28 }: AvatarProps): JSX.Element {
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "var(--radius-full)",
        background: hashColor(name),
        color: "#fff",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: size * 0.38,
        fontWeight: 650,
        flexShrink: 0
      }}
    >
      {initials(name)}
    </div>
  );
}
