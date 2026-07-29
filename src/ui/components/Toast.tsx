import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { AlertTriangleIcon, CheckIcon, InfoIcon, XIcon } from "./Icons.js";

type ToastTone = "success" | "error" | "info";

interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
}

interface ToastContextValue {
  showToast: (message: string, tone?: ToastTone) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const TONE_STYLE: Record<ToastTone, { border: string; icon: ReactNode; color: string }> = {
  success: { border: "var(--color-success)", color: "var(--color-success)", icon: <CheckIcon size={16} /> },
  error: { border: "var(--color-danger)", color: "var(--color-danger)", icon: <AlertTriangleIcon size={16} /> },
  info: { border: "var(--color-info)", color: "var(--color-info)", icon: <InfoIcon size={16} /> }
};

const AUTO_DISMISS_MS = 5000;

/** App-wide toast notifications (replaces ad-hoc window.alert() calls) so a background action's
 * result -- "Enrolled 12 contacts", a failed IPC call -- is surfaced consistently everywhere. */
export function ToastProvider({ children }: { children: ReactNode }): JSX.Element {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const showToast = useCallback((message: string, tone: ToastTone = "info") => {
    const id = nextId.current++;
    setToasts((prev) => [...prev, { id, tone, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, AUTO_DISMISS_MS);
  }, []);

  function dismiss(id: number): void {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div
        style={{
          position: "fixed",
          bottom: "var(--space-6)",
          right: "var(--space-6)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-2)",
          zIndex: 2000,
          maxWidth: 360
        }}
      >
        {toasts.map((t) => {
          const s = TONE_STYLE[t.tone];
          return (
            <div
              key={t.id}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: "0.5rem",
                background: "var(--color-surface)",
                border: "1px solid var(--color-border)",
                borderLeft: `3px solid ${s.border}`,
                borderRadius: "var(--radius-md)",
                boxShadow: "var(--shadow-md)",
                padding: "10px 12px",
                fontSize: "13px",
                color: "var(--color-text-primary)",
                animation: "ob-fade-in 150ms ease-out"
              }}
            >
              <span style={{ color: s.color, marginTop: 1 }}>{s.icon}</span>
              <span style={{ flex: 1, lineHeight: 1.5 }}>{t.message}</span>
              <button
                onClick={() => dismiss(t.id)}
                aria-label="Dismiss"
                style={{ border: "none", background: "transparent", color: "var(--color-text-tertiary)", cursor: "pointer", padding: 2 }}
              >
                <XIcon size={14} />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within a ToastProvider");
  return ctx;
}
