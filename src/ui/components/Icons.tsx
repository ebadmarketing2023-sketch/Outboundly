import type { CSSProperties } from "react";

/**
 * A small, hand-built line-icon set (stroke-based, 24x24 viewBox) so the app doesn't depend on an
 * external icon package or any network/CDN asset (the renderer's CSP is script-src 'self').
 * Every icon is built from plain SVG primitives (rect/circle/line/polyline/path with simple
 * segments) rather than reproducing a specific icon library's bezier path data from memory.
 */

export interface IconProps {
  size?: number;
  style?: CSSProperties;
  className?: string;
}

function base(size: number) {
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none" as const,
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const
  };
}

export function MailIcon({ size = 18, style, className }: IconProps) {
  return (
    <svg {...base(size)} style={style} className={className}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <polyline points="3.5,6.5 12,13 20.5,6.5" />
    </svg>
  );
}

export function InboxIcon({ size = 18, style, className }: IconProps) {
  return (
    <svg {...base(size)} style={style} className={className}>
      <path d="M3 12h5l1.5 3h5L16 12h5" />
      <path d="M5.5 5h13L21 12v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5L5.5 5Z" />
    </svg>
  );
}

export function ActivityIcon({ size = 18, style, className }: IconProps) {
  return (
    <svg {...base(size)} style={style} className={className}>
      <polyline points="3,12 8,12 10,18 14,6 16,12 21,12" />
    </svg>
  );
}

export function FlaskIcon({ size = 18, style, className }: IconProps) {
  return (
    <svg {...base(size)} style={style} className={className}>
      <path d="M10 3h4" />
      <path d="M10 3v6l-5.5 9.5A1.6 1.6 0 0 0 5.9 21h12.2a1.6 1.6 0 0 0 1.4-2.5L14 9V3" />
      <path d="M7.5 15h9" />
    </svg>
  );
}

export function UsersIcon({ size = 18, style, className }: IconProps) {
  return (
    <svg {...base(size)} style={style} className={className}>
      <circle cx="9" cy="8" r="3" />
      <path d="M3.5 20a5.5 5.5 0 0 1 11 0" />
      <circle cx="17" cy="9" r="2.4" />
      <path d="M14.5 20a4.5 4.5 0 0 1 6.5-4" />
    </svg>
  );
}

export function MegaphoneIcon({ size = 18, style, className }: IconProps) {
  return (
    <svg {...base(size)} style={style} className={className}>
      <path d="M3 11v2a1.5 1.5 0 0 0 1.5 1.5H6l2.5 5 1.4-.5-1.9-4.5H10l8 4V6l-8 4H4.5A1.5 1.5 0 0 0 3 11Z" />
      <path d="M18 9.5v5" />
    </svg>
  );
}

export function BarChartIcon({ size = 18, style, className }: IconProps) {
  return (
    <svg {...base(size)} style={style} className={className}>
      <line x1="4" y1="20" x2="20" y2="20" />
      <rect x="6" y="12" width="3.2" height="8" />
      <rect x="10.4" y="7" width="3.2" height="13" />
      <rect x="14.8" y="10" width="3.2" height="10" />
      <rect x="19.2" y="4" width="0" height="0" opacity="0" />
    </svg>
  );
}

export function BellIcon({ size = 18, style, className }: IconProps) {
  return (
    <svg {...base(size)} style={style} className={className}>
      <path d="M6 10a6 6 0 0 1 12 0v4.5l1.5 2.5h-15L6 14.5Z" />
      <path d="M10 19.5a2 2 0 0 0 4 0" />
    </svg>
  );
}

export function SettingsIcon({ size = 18, style, className }: IconProps) {
  return (
    <svg {...base(size)} style={style} className={className}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3.5v2.2M12 18.3v2.2M20.5 12h-2.2M5.7 12H3.5M17.7 6.3l-1.55 1.55M7.85 16.15 6.3 17.7M17.7 17.7l-1.55-1.55M7.85 7.85 6.3 6.3" />
    </svg>
  );
}

export function SearchIcon({ size = 18, style, className }: IconProps) {
  return (
    <svg {...base(size)} style={style} className={className}>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <line x1="15.3" y1="15.3" x2="21" y2="21" />
    </svg>
  );
}

export function PlusIcon({ size = 18, style, className }: IconProps) {
  return (
    <svg {...base(size)} style={style} className={className}>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

export function TrashIcon({ size = 18, style, className }: IconProps) {
  return (
    <svg {...base(size)} style={style} className={className}>
      <polyline points="4,7 20,7" />
      <path d="M9 7V4.5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1V7" />
      <path d="M6.5 7 7.3 20a1 1 0 0 0 1 1h7.4a1 1 0 0 0 1-1L17.5 7" />
    </svg>
  );
}

export function ChevronDownIcon({ size = 18, style, className }: IconProps) {
  return (
    <svg {...base(size)} style={style} className={className}>
      <polyline points="6,9 12,15 18,9" />
    </svg>
  );
}

export function ChevronRightIcon({ size = 18, style, className }: IconProps) {
  return (
    <svg {...base(size)} style={style} className={className}>
      <polyline points="9,6 15,12 9,18" />
    </svg>
  );
}

export function XIcon({ size = 18, style, className }: IconProps) {
  return (
    <svg {...base(size)} style={style} className={className}>
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="18" y1="6" x2="6" y2="18" />
    </svg>
  );
}

export function CheckIcon({ size = 18, style, className }: IconProps) {
  return (
    <svg {...base(size)} style={style} className={className}>
      <polyline points="4,12.5 9.5,18 20,6" />
    </svg>
  );
}

export function AlertTriangleIcon({ size = 18, style, className }: IconProps) {
  return (
    <svg {...base(size)} style={style} className={className}>
      <path d="M12 4 2.5 20h19L12 4Z" />
      <line x1="12" y1="10" x2="12" y2="14.5" />
      <line x1="12" y1="17" x2="12" y2="17.05" />
    </svg>
  );
}

export function InfoIcon({ size = 18, style, className }: IconProps) {
  return (
    <svg {...base(size)} style={style} className={className}>
      <circle cx="12" cy="12" r="9" />
      <line x1="12" y1="11" x2="12" y2="16" />
      <line x1="12" y1="7.5" x2="12" y2="7.55" />
    </svg>
  );
}

export function StarIcon({ size = 18, style, className, filled = false }: IconProps & { filled?: boolean }) {
  const points = "12,3.5 14.7,9.2 21,10.1 16.5,14.4 17.6,20.6 12,17.6 6.4,20.6 7.5,14.4 3,10.1 9.3,9.2";
  return (
    <svg {...base(size)} style={style} className={className} fill={filled ? "currentColor" : "none"}>
      <polygon points={points} />
    </svg>
  );
}

export function ArchiveIcon({ size = 18, style, className }: IconProps) {
  return (
    <svg {...base(size)} style={style} className={className}>
      <rect x="3" y="4" width="18" height="4.5" rx="1" />
      <path d="M4.5 8.5v9a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-9" />
      <line x1="10" y1="12.5" x2="14" y2="12.5" />
    </svg>
  );
}

export function RefreshIcon({ size = 18, style, className }: IconProps) {
  return (
    <svg {...base(size)} style={style} className={className}>
      <path d="M4.5 12a7.5 7.5 0 0 1 12.8-5.3L19 8.3" />
      <polyline points="19,4 19,8.3 14.7,8.3" />
      <path d="M19.5 12a7.5 7.5 0 0 1-12.8 5.3L5 15.7" />
      <polyline points="5,20 5,15.7 9.3,15.7" />
    </svg>
  );
}

export function SendIcon({ size = 18, style, className }: IconProps) {
  return (
    <svg {...base(size)} style={style} className={className}>
      <path d="m3 11 18-7-7 18-2.5-7.5L3 11Z" />
      <line x1="13.5" y1="14.5" x2="21" y2="4" />
    </svg>
  );
}

export function DownloadIcon({ size = 18, style, className }: IconProps) {
  return (
    <svg {...base(size)} style={style} className={className}>
      <path d="M12 3.5v11" />
      <polyline points="7.5,10.5 12,15 16.5,10.5" />
      <path d="M4.5 17v2a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-2" />
    </svg>
  );
}

export function UploadIcon({ size = 18, style, className }: IconProps) {
  return (
    <svg {...base(size)} style={style} className={className}>
      <path d="M12 15.5v-11" />
      <polyline points="7.5,8 12,3.5 16.5,8" />
      <path d="M4.5 17v2a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-2" />
    </svg>
  );
}

export function ClockIcon({ size = 18, style, className }: IconProps) {
  return (
    <svg {...base(size)} style={style} className={className}>
      <circle cx="12" cy="12" r="9" />
      <polyline points="12,7 12,12 16,14.5" />
    </svg>
  );
}

export function UserIcon({ size = 18, style, className }: IconProps) {
  return (
    <svg {...base(size)} style={style} className={className}>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
    </svg>
  );
}

export function ChevronUpDownIcon({ size = 18, style, className }: IconProps) {
  return (
    <svg {...base(size)} style={style} className={className}>
      <polyline points="7,10 12,5.5 17,10" />
      <polyline points="7,14 12,18.5 17,14" />
    </svg>
  );
}

export function ExternalLinkIcon({ size = 18, style, className }: IconProps) {
  return (
    <svg {...base(size)} style={style} className={className}>
      <path d="M9 6H6.5A1.5 1.5 0 0 0 5 7.5v10A1.5 1.5 0 0 0 6.5 19h10a1.5 1.5 0 0 0 1.5-1.5V15" />
      <path d="M13.5 4.5H19.5V10.5" />
      <line x1="19.5" y1="4.5" x2="11" y2="13" />
    </svg>
  );
}

export function KeyIcon({ size = 18, style, className }: IconProps) {
  return (
    <svg {...base(size)} style={style} className={className}>
      <circle cx="8" cy="15.5" r="4" />
      <path d="M11 12.5 19 4.5" />
      <path d="M16 7.5 18.5 10" />
      <path d="M13.3 10.2l2 2" />
    </svg>
  );
}

export function TargetIcon({ size = 18, style, className }: IconProps) {
  return (
    <svg {...base(size)} style={style} className={className}>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="4.8" />
      <circle cx="12" cy="12" r="1" fill="currentColor" />
    </svg>
  );
}
