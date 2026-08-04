import { useEffect, useState, type ReactNode } from "react";
import { ComposeScreen } from "./compose/ComposeScreen.js";
import { InboxScreen } from "./unified-inbox/InboxScreen.js";
import { AccountHealthScreen } from "./account-health/AccountHealthScreen.js";
import { LeadsScreen } from "./leads/LeadsScreen.js";
import { CampaignsScreen } from "./campaigns/CampaignsScreen.js";
import { AnalyticsScreen } from "./analytics/AnalyticsScreen.js";
import { NotificationsScreen } from "./notifications/NotificationsScreen.js";
import { SettingsScreen } from "./settings/SettingsScreen.js";
import { BUILT_AT } from "./build-info.js";
import {
  ActivityIcon,
  BarChartIcon,
  BellIcon,
  InboxIcon,
  MailIcon,
  MegaphoneIcon,
  SettingsIcon,
  UsersIcon
} from "./components/index.js";

type Tab =
  | "compose"
  | "inbox"
  | "account-health"
  | "leads"
  | "campaigns"
  | "analytics"
  | "notifications"
  | "settings";

interface NavItem {
  key: Tab;
  label: string;
  icon: ReactNode;
  screen: ReactNode;
}

export function App(): JSX.Element {
  const [tab, setTab] = useState<Tab>("compose");
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    window.outboundly
      .listUnreadNotifications()
      .then((list) => setUnreadCount(list.length))
      .catch(() => undefined);
  }, [tab]);

  const items: NavItem[] = [
    { key: "compose", label: "Compose", icon: <MailIcon size={17} />, screen: <ComposeScreen /> },
    { key: "inbox", label: "Inbox", icon: <InboxIcon size={17} />, screen: <InboxScreen /> },
    { key: "campaigns", label: "Campaigns", icon: <MegaphoneIcon size={17} />, screen: <CampaignsScreen /> },
    { key: "leads", label: "Leads", icon: <UsersIcon size={17} />, screen: <LeadsScreen /> },
    { key: "analytics", label: "Analytics", icon: <BarChartIcon size={17} />, screen: <AnalyticsScreen /> },
    { key: "account-health", label: "Account Health", icon: <ActivityIcon size={17} />, screen: <AccountHealthScreen /> },
    { key: "notifications", label: "Notifications", icon: <BellIcon size={17} />, screen: <NotificationsScreen /> },
    { key: "settings", label: "Settings", icon: <SettingsIcon size={17} />, screen: <SettingsScreen /> }
  ];

  const active = items.find((i) => i.key === tab) ?? items[0]!;

  return (
    <div style={{ display: "flex", height: "100vh", background: "var(--color-bg)" }}>
      <aside
        style={{
          width: "var(--sidebar-width)",
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          borderRight: "1px solid var(--color-border)",
          background: "var(--color-surface)"
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "0.55rem", padding: "18px 18px 14px" }}>
          <div
            style={{
              width: 26,
              height: 26,
              borderRadius: "8px",
              background: "var(--color-primary)",
              color: "#fff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontWeight: 700,
              fontSize: "14px",
              flexShrink: 0
            }}
          >
            O
          </div>
          <span style={{ fontWeight: 650, fontSize: "15px", letterSpacing: "-0.01em" }}>Outboundly</span>
        </div>

        <nav style={{ flex: 1, padding: "6px 10px", display: "flex", flexDirection: "column", gap: "2px", overflowY: "auto" }}>
          {items.map((item) => {
            const isActive = item.key === tab;
            return (
              <button
                key={item.key}
                onClick={() => setTab(item.key)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.6rem",
                  width: "100%",
                  padding: "8px 10px",
                  border: "none",
                  borderRadius: "var(--radius-md)",
                  background: isActive ? "var(--color-primary-light)" : "transparent",
                  color: isActive ? "var(--color-primary)" : "var(--color-text-secondary)",
                  fontSize: "13.5px",
                  fontWeight: isActive ? 600 : 500,
                  cursor: "pointer",
                  textAlign: "left"
                }}
                onMouseEnter={(e) => {
                  if (!isActive) e.currentTarget.style.background = "var(--color-surface-hover)";
                }}
                onMouseLeave={(e) => {
                  if (!isActive) e.currentTarget.style.background = "transparent";
                }}
              >
                <span style={{ display: "flex", flexShrink: 0 }}>{item.icon}</span>
                <span style={{ flex: 1 }}>{item.label}</span>
                {item.key === "notifications" && unreadCount > 0 && (
                  <span
                    style={{
                      fontSize: "11px",
                      fontWeight: 700,
                      minWidth: 18,
                      height: 18,
                      padding: "0 5px",
                      borderRadius: "var(--radius-full)",
                      background: isActive ? "var(--color-primary)" : "var(--color-danger)",
                      color: "#fff",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center"
                    }}
                  >
                    {unreadCount > 99 ? "99+" : unreadCount}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        <div style={{ padding: "12px 18px", fontSize: "11px", color: "var(--color-text-tertiary)" }}>Build {BUILT_AT}</div>
      </aside>

      <main style={{ flex: 1, minWidth: 0, overflowY: "auto" }}>
        <div style={{ maxWidth: 1180, margin: "0 auto", padding: "var(--space-8)" }}>{active.screen}</div>
      </main>
    </div>
  );
}
