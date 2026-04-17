import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { DecisionDetail } from "../../lib/api-client.js";
import { classifyLine } from "../revisions/DiffViewer.js";

interface ReviewDetailProps {
  decision: DecisionDetail;
  onApprove: () => void | Promise<void>;
  onReject: (reason?: string) => void | Promise<void>;
}

export function ReviewDetail({ decision, onApprove, onReject }: ReviewDetailProps) {
  const { t } = useTranslation(["review", "common"]);
  const [submitting, setSubmitting] = useState<"approve" | "reject" | null>(null);
  const [rejectMode, setRejectMode] = useState(false);
  const [rejectReason, setRejectReason] = useState("");

  const resolved =
    decision.status === "approved" ||
    decision.status === "rejected" ||
    decision.status === "auto_applied" ||
    decision.status === "noop";

  const doApprove = async () => {
    setSubmitting("approve");
    try {
      await onApprove();
    } finally {
      setSubmitting(null);
    }
  };

  const doReject = async () => {
    setSubmitting("reject");
    try {
      await onReject(rejectReason.trim() || undefined);
      setRejectMode(false);
      setRejectReason("");
    } finally {
      setSubmitting(null);
    }
  };

  const diffLines = decision.proposedRevision?.diffMd
    ? decision.proposedRevision.diffMd.split("\n")
    : [];

  return (
    <div className="review-detail-body">
      <div className="review-detail-header">
        <div>
          <div className="review-detail-title">
            {decision.action === "create"
              ? t("newPage", {
                  title:
                    decision.proposedPageTitle ??
                    decision.ingestion.titleHint ??
                    t("common:untitled"),
                })
              : (decision.targetPage?.title ??
                decision.ingestion.titleHint ??
                t("common:untitled"))}
          </div>
          <div className="review-detail-meta">
            <span className={`review-badge review-badge-${decision.status}`}>
              {t(`badge.${decision.status}`, { defaultValue: decision.status })}
            </span>
            <span className="review-action-chip">
              {t(`action.${decision.action}`, { defaultValue: decision.action })}
            </span>
            <span>
              {t("confidence")}: {Math.round(decision.confidence * 100)}%
            </span>
            <span>
              {t("source")}: {decision.ingestion.sourceName}
            </span>
          </div>
        </div>
      </div>

      {decision.reason && (
        <div className="review-detail-section">
          <div className="review-detail-label">{t("reason")}</div>
          <div className="review-detail-reason">{decision.reason}</div>
        </div>
      )}

      {decision.proposedRevision?.diffMd ? (
        <div className="review-detail-section">
          <div className="review-detail-label">
            {t("proposedDiff")}
            {decision.proposedRevision.changedBlocks != null && (
              <span className="review-detail-label-sub">
                {" "}
                ({decision.proposedRevision.changedBlocks} blocks)
              </span>
            )}
          </div>
          <pre className="review-diff">
            {diffLines.map((line, i) => (
              <span key={i} className={classifyLine(line)}>
                {line}
                {"\n"}
              </span>
            ))}
          </pre>
        </div>
      ) : decision.proposedRevision?.contentMd ? (
        <div className="review-detail-section">
          <div className="review-detail-label">{t("proposedContent")}</div>
          <pre className="review-content-preview">
            {decision.proposedRevision.contentMd}
          </pre>
        </div>
      ) : (
        <div className="review-detail-section">
          <div className="review-detail-label">{t("normalizedText")}</div>
          <pre className="review-content-preview">
            {decision.ingestion.normalizedText ?? t("noReason")}
          </pre>
        </div>
      )}

      <details className="review-detail-collapsible">
        <summary>{t("rawPayload")}</summary>
        <pre className="review-content-preview">
          {JSON.stringify(decision.ingestion.rawPayload, null, 2)}
        </pre>
      </details>

      {!resolved && (
        <div className="review-detail-actions">
          {rejectMode ? (
            <div className="review-reject-form">
              <label htmlFor="reject-reason">{t("rejectReason")}</label>
              <textarea
                id="reject-reason"
                rows={3}
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                placeholder={t("rejectReasonPlaceholder")}
              />
              <div className="review-reject-buttons">
                <button
                  className="btn btn-secondary"
                  onClick={() => {
                    setRejectMode(false);
                    setRejectReason("");
                  }}
                  disabled={submitting === "reject"}
                >
                  {t("common:cancel")}
                </button>
                <button
                  className="btn btn-danger"
                  onClick={doReject}
                  disabled={submitting === "reject"}
                >
                  {submitting === "reject" ? t("rejecting") : t("reject")}
                </button>
              </div>
            </div>
          ) : (
            <>
              <button
                className="btn btn-secondary"
                onClick={() => setRejectMode(true)}
                disabled={submitting !== null}
              >
                {t("reject")}
              </button>
              <button
                className="btn btn-primary"
                onClick={doApprove}
                disabled={submitting !== null}
              >
                {submitting === "approve" ? t("approving") : t("approve")}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
