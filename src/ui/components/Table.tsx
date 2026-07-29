import type { CSSProperties, ReactNode, ThHTMLAttributes, TdHTMLAttributes } from "react";

export function Table({ children, style }: { children: ReactNode; style?: CSSProperties }): JSX.Element {
  return (
    <div className="ob-scroll-x">
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13.5px", ...style }}>{children}</table>
    </div>
  );
}

export function Th({ children, align, style, ...rest }: ThHTMLAttributes<HTMLTableCellElement> & { align?: "left" | "right" | "center" }): JSX.Element {
  return (
    <th
      style={{
        textAlign: align ?? "left",
        padding: "8px 14px",
        fontSize: "11.5px",
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.03em",
        color: "var(--color-text-tertiary)",
        borderBottom: "1px solid var(--color-border)",
        whiteSpace: "nowrap",
        ...style
      }}
      {...rest}
    >
      {children}
    </th>
  );
}

export function Td({ children, align, style, ...rest }: TdHTMLAttributes<HTMLTableCellElement> & { align?: "left" | "right" | "center" }): JSX.Element {
  return (
    <td
      style={{
        textAlign: align ?? "left",
        padding: "11px 14px",
        borderBottom: "1px solid var(--color-border)",
        color: "var(--color-text-primary)",
        verticalAlign: "middle",
        ...style
      }}
      {...rest}
    >
      {children}
    </td>
  );
}

export function TableRow({ children, onClick, style }: { children: ReactNode; onClick?: () => void; style?: CSSProperties }): JSX.Element {
  return (
    <tr
      onClick={onClick}
      style={{ cursor: onClick ? "pointer" : undefined, transition: "background-color 100ms ease", ...style }}
      onMouseEnter={(e) => {
        if (onClick) e.currentTarget.style.background = "var(--color-surface-hover)";
      }}
      onMouseLeave={(e) => {
        if (onClick) e.currentTarget.style.background = "";
      }}
    >
      {children}
    </tr>
  );
}
