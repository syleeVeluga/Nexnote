import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useWorkspace } from "../hooks/use-workspace.js";
import { pages as pagesApi } from "../lib/api-client.js";
import { ConfirmDialog } from "../components/modals/ConfirmDialog.js";

interface TrashRow {
  id: string;
  title: string;
  slug: string;
  deletedAt: string | null;
  deletedByUserId: string | null;
  deletedByUserName: string | null;
  descendantCount: number;
}

type PendingAction =
  | { kind: "restore"; row: TrashRow }
  | { kind: "purge"; row: TrashRow }
  | null;

export function TrashPage() {
  const { t } = useTranslation("common");
  const { current } = useWorkspace();
  const [rows, setRows] = useState<TrashRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<PendingAction>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    if (!current) return;
    setLoading(true);
    pagesApi
      .listTrash(current.id)
      .then((res) => setRows(res.data))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [current]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const confirmAction = useCallback(async () => {
    if (!pending || !current) return;
    setBusy(true);
    try {
      if (pending.kind === "restore") {
        await pagesApi.restore(current.id, pending.row.id);
      } else {
        await pagesApi.purge(current.id, pending.row.id);
      }
      setPending(null);
      refresh();
    } catch {
      alert(t("deleteFailed"));
    } finally {
      setBusy(false);
    }
  }, [pending, current, refresh, t]);

  if (!current) return null;

  return (
    <div className="trash-page">
      <h1>{t("trash")}</h1>
      <p className="trash-page-description">{t("trashDescription")}</p>

      {loading ? (
        <p>{t("loading")}</p>
      ) : rows.length === 0 ? (
        <div className="trash-empty">{t("trashEmpty")}</div>
      ) : (
        <table className="trash-table">
          <thead>
            <tr>
              <th>{t("columnTitle")}</th>
              <th>{t("descendantCount")}</th>
              <th>{t("deletedBy")}</th>
              <th>{t("deletedAt")}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{row.title || t("untitled")}</td>
                <td>{row.descendantCount}</td>
                <td>{row.deletedByUserName ?? "—"}</td>
                <td>
                  {row.deletedAt
                    ? new Date(row.deletedAt).toLocaleString()
                    : "—"}
                </td>
                <td>
                  <div className="trash-actions">
                    <button
                      className="btn-sm"
                      onClick={() => setPending({ kind: "restore", row })}
                    >
                      {t("restore")}
                    </button>
                    <button
                      className="btn-sm btn-confirm-danger"
                      onClick={() => setPending({ kind: "purge", row })}
                    >
                      {t("permanentlyDelete")}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <ConfirmDialog
        open={pending?.kind === "restore"}
        title={t("restore")}
        message={
          pending?.kind === "restore"
            ? t("restoreConfirm", { title: pending.row.title })
            : ""
        }
        confirmLabel={t("restore")}
        confirmVariant="primary"
        onConfirm={confirmAction}
        onCancel={() => setPending(null)}
        busy={busy}
      />

      <ConfirmDialog
        open={pending?.kind === "purge"}
        title={t("permanentlyDelete")}
        message={
          pending?.kind === "purge"
            ? t("permanentlyDeleteConfirm", { title: pending.row.title })
            : ""
        }
        confirmLabel={t("permanentlyDelete")}
        confirmVariant="danger"
        onConfirm={confirmAction}
        onCancel={() => setPending(null)}
        busy={busy}
      />
    </div>
  );
}
