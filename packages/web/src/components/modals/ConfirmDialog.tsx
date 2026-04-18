import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

export interface ConfirmDialogAction {
  label: string;
  onClick: () => void | Promise<void>;
  variant?: "primary" | "danger" | "secondary";
  disabled?: boolean;
}

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  confirmVariant?: "primary" | "danger";
  cancelLabel?: string;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
  /** Optional secondary action for branched flows (e.g. "unpublish and delete"). */
  extraActions?: ConfirmDialogAction[];
  /** Disable the confirm button while an async action is in-flight. */
  busy?: boolean;
}

/**
 * Minimal confirm dialog. No portal/focus-trap library dependency — we
 * just auto-focus cancel, dismiss on ESC or backdrop click, and let the
 * caller drive loading state via `busy`.
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  confirmVariant = "danger",
  cancelLabel,
  onConfirm,
  onCancel,
  extraActions,
  busy,
}: ConfirmDialogProps) {
  const { t } = useTranslation("common");
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    cancelRef.current?.focus();
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, busy, onCancel]);

  if (!open) return null;

  const confirmClass =
    confirmVariant === "danger" ? "btn-confirm-danger" : "btn-primary";

  return (
    <div
      className="confirm-dialog-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <div className="confirm-dialog" role="dialog" aria-modal="true">
        <h3 className="confirm-dialog-title">{title}</h3>
        <p className="confirm-dialog-message">{message}</p>
        <div className="confirm-dialog-actions">
          <button
            ref={cancelRef}
            className="btn-sm"
            onClick={onCancel}
            disabled={busy}
          >
            {cancelLabel ?? t("cancel")}
          </button>
          {(extraActions ?? []).map((action, i) => (
            <button
              key={i}
              className={`btn-sm ${
                action.variant === "primary"
                  ? "btn-primary"
                  : action.variant === "danger"
                    ? "btn-confirm-danger"
                    : ""
              }`}
              onClick={() => void action.onClick()}
              disabled={busy || action.disabled}
            >
              {action.label}
            </button>
          ))}
          <button
            className={`btn-sm ${confirmClass}`}
            onClick={() => void onConfirm()}
            disabled={busy}
          >
            {confirmLabel ?? t("ok")}
          </button>
        </div>
      </div>
    </div>
  );
}
