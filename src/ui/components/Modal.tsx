import { useEffect, type ReactNode } from "react";
import { Button } from "./Button.js";
import { XIcon } from "./Icons.js";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}

/** The single modal primitive every dialog in the app (confirmations, forms) is built on, so
 * overlay behavior, escape-to-close, and layout are consistent everywhere. */
export function Modal({ open, onClose, title, children, footer, width = 480 }: ModalProps): JSX.Element | null {
  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent): void {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(16, 24, 40, 0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        animation: "ob-fade-in 100ms ease-out"
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        style={{
          width,
          maxWidth: "calc(100vw - 48px)",
          maxHeight: "calc(100vh - 64px)",
          display: "flex",
          flexDirection: "column",
          background: "var(--color-surface)",
          borderRadius: "var(--radius-lg)",
          boxShadow: "var(--shadow-lg)",
          overflow: "hidden"
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "var(--space-5) var(--space-6)",
            borderBottom: "1px solid var(--color-border)"
          }}
        >
          <h2 style={{ fontSize: "15px", fontWeight: 600 }}>{title}</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              display: "flex",
              border: "none",
              background: "transparent",
              color: "var(--color-text-tertiary)",
              cursor: "pointer",
              padding: 4,
              borderRadius: "var(--radius-sm)"
            }}
          >
            <XIcon size={18} />
          </button>
        </div>
        <div style={{ padding: "var(--space-6)", overflowY: "auto" }}>{children}</div>
        {footer && (
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: "var(--space-2)",
              padding: "var(--space-4) var(--space-6)",
              borderTop: "1px solid var(--color-border)",
              background: "var(--color-surface-hover)"
            }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  title: ReactNode;
  description: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** The one confirm-before-destructive-action dialog used across the app (restoring a backup,
 * unsubscribing a contact, etc.) so every "are you sure?" prompt looks and behaves the same. */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = false,
  busy = false,
  onConfirm,
  onCancel
}: ConfirmDialogProps): JSX.Element | null {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      width={420}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button variant={danger ? "danger" : "primary"} onClick={onConfirm} loading={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p style={{ fontSize: "13.5px", color: "var(--color-text-secondary)", lineHeight: 1.6 }}>{description}</p>
    </Modal>
  );
}
