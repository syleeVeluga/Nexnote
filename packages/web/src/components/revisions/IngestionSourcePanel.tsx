import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  decisions as decisionsApi,
  type DecisionDetail,
} from "../../lib/api-client.js";

interface IngestionSourcePanelProps {
  workspaceId: string;
  decisionId: string;
  onClose: () => void;
}

export function IngestionSourcePanel({
  workspaceId,
  decisionId,
  onClose,
}: IngestionSourcePanelProps) {
  const { t } = useTranslation(["editor", "common"]);
  const [detail, setDetail] = useState<DecisionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    decisionsApi
      .get(workspaceId, decisionId)
      .then((res) => {
        if (!cancelled) setDetail(res);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, decisionId]);

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  return (
    <div className="diff-viewer-overlay" onClick={handleOverlayClick}>
      <div className="diff-viewer-modal source-panel">
        <div className="diff-viewer-header">
          <h3>{t("sourceIngestion")}</h3>
          <button className="btn-close-panel" onClick={onClose}>
            &times;
          </button>
        </div>
        <div className="diff-content">
          {loading ? (
            <div className="diff-empty">{t("common:loading")}</div>
          ) : error || !detail ? (
            <div className="diff-empty">{t("sourceLoadFailed")}</div>
          ) : (
            <div className="source-panel-body">
              <dl className="source-panel-meta">
                <dt>{t("sourceAction")}</dt>
                <dd>
                  <span className="review-action-chip">{detail.action}</span>
                </dd>
                <dt>{t("sourceConfidence")}</dt>
                <dd>{Math.round(detail.confidence * 100)}%</dd>
                <dt>{t("source")}</dt>
                <dd>
                  {detail.ingestion.sourceName}
                  {detail.ingestion.externalRef
                    ? ` · ${detail.ingestion.externalRef}`
                    : ""}
                </dd>
                <dt>{t("sourceReceivedAt")}</dt>
                <dd>
                  {new Date(detail.ingestion.receivedAt).toLocaleString()}
                </dd>
              </dl>

              {detail.reason && (
                <div className="source-panel-section">
                  <div className="source-panel-label">
                    {t("sourceDecisionReason")}
                  </div>
                  <div className="source-panel-reason">{detail.reason}</div>
                </div>
              )}

              {detail.ingestion.normalizedText && (
                <div className="source-panel-section">
                  <div className="source-panel-label">
                    {t("sourceIngestion")}
                  </div>
                  <pre className="review-content-preview">
                    {detail.ingestion.normalizedText}
                  </pre>
                </div>
              )}

              <details className="review-detail-collapsible">
                <summary>{t("sourceRawPayload")}</summary>
                <pre className="review-content-preview">
                  {JSON.stringify(detail.ingestion.rawPayload, null, 2)}
                </pre>
              </details>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
