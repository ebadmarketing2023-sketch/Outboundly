import { useEffect, useState } from "react";
import { ComposeScreen } from "./compose/ComposeScreen.js";
import { InboxScreen } from "./unified-inbox/InboxScreen.js";
import { AccountHealthScreen } from "./account-health/AccountHealthScreen.js";
import { DeliverabilityLabScreen } from "./deliverability-lab/DeliverabilityLabScreen.js";
import { LeadsScreen } from "./leads/LeadsScreen.js";
import { CampaignsScreen } from "./campaigns/CampaignsScreen.js";
import { AnalyticsScreen } from "./analytics/AnalyticsScreen.js";
import { NotificationsScreen } from "./notifications/NotificationsScreen.js";
import { BUILT_AT } from "./build-info.js";

type Tab = "compose" | "inbox" | "account-health" | "deliverability-lab" | "leads" | "campaigns" | "analytics" | "notifications";

export function App(): JSX.Element {
  const [tab, setTab] = useState<Tab>("compose");
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    window.outboundly.listUnreadNotifications().then((list) => setUnreadCount(list.length)).catch(() => undefined);
  }, [tab]);

  return (
    <div>
      <nav style={{ display: "flex", alignItems: "center", gap: "0.5rem", padding: "0.5rem", borderBottom: "1px solid #ddd" }}>
        <button onClick={() => setTab("compose")} disabled={tab === "compose"}>
          Compose
        </button>
        <button onClick={() => setTab("inbox")} disabled={tab === "inbox"}>
          Inbox
        </button>
        <button onClick={() => setTab("account-health")} disabled={tab === "account-health"}>
          Account Health
        </button>
        <button onClick={() => setTab("deliverability-lab")} disabled={tab === "deliverability-lab"}>
          Deliverability Lab
        </button>
        <button onClick={() => setTab("leads")} disabled={tab === "leads"}>
          Leads
        </button>
        <button onClick={() => setTab("campaigns")} disabled={tab === "campaigns"}>
          Campaigns
        </button>
        <button onClick={() => setTab("analytics")} disabled={tab === "analytics"}>
          Analytics
        </button>
        <button onClick={() => setTab("notifications")} disabled={tab === "notifications"}>
          Notifications{unreadCount > 0 ? ` (${unreadCount})` : ""}
        </button>
        <span style={{ marginLeft: "auto", color: "#888", fontSize: "0.8rem" }}>Build: {BUILT_AT}</span>
      </nav>
      {tab === "compose" && <ComposeScreen />}
      {tab === "inbox" && <InboxScreen />}
      {tab === "account-health" && <AccountHealthScreen />}
      {tab === "deliverability-lab" && <DeliverabilityLabScreen />}
      {tab === "leads" && <LeadsScreen />}
      {tab === "campaigns" && <CampaignsScreen />}
      {tab === "analytics" && <AnalyticsScreen />}
      {tab === "notifications" && <NotificationsScreen />}
    </div>
  );
}
