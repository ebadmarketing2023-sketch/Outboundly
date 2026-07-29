export interface TabItem {
  key: string;
  label: string;
  count?: number;
}

export interface TabsProps {
  items: TabItem[];
  active: string;
  onChange: (key: string) => void;
}

/** A horizontal tab bar used to split a screen with several logical sections (Campaigns'
 * setup steps, Settings' groups) without stacking every section vertically. */
export function Tabs({ items, active, onChange }: TabsProps): JSX.Element {
  return (
    <div style={{ display: "flex", gap: "var(--space-1)", borderBottom: "1px solid var(--color-border)", marginBottom: "var(--space-6)" }}>
      {items.map((item) => {
        const isActive = item.key === active;
        return (
          <button
            key={item.key}
            onClick={() => onChange(item.key)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "6px",
              padding: "10px 14px",
              fontSize: "13.5px",
              fontWeight: 550,
              border: "none",
              borderBottom: `2px solid ${isActive ? "var(--color-primary)" : "transparent"}`,
              background: "transparent",
              color: isActive ? "var(--color-primary)" : "var(--color-text-secondary)",
              cursor: "pointer",
              marginBottom: "-1px"
            }}
          >
            {item.label}
            {item.count !== undefined && (
              <span
                style={{
                  fontSize: "11.5px",
                  fontWeight: 600,
                  padding: "1px 6px",
                  borderRadius: "var(--radius-full)",
                  background: isActive ? "var(--color-primary-light)" : "var(--color-surface-hover)",
                  color: isActive ? "var(--color-primary)" : "var(--color-text-tertiary)"
                }}
              >
                {item.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
