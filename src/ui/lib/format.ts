/** Shared display formatting so dates/rates aren't formatted slightly differently on every screen. */

export function formatDateTime(value: string | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function formatDate(value: string | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { dateStyle: "medium" });
}

export function formatPercent(rate: number | undefined): string {
  return rate === undefined ? "—" : `${Math.round(rate * 100)}%`;
}

export function humanizeSnakeCase(value: string): string {
  return value
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
