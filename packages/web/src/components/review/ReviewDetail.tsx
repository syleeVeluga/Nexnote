import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  CalendarClock,
  Check,
  ExternalLink,
  FileText,
  RotateCcw,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import type { DecisionDetail } from "../../lib/api-client.js";
import { classifyLine } from "../revisions/DiffViewer.js";
import { Badge, type BadgeTone } from "../ui/Badge.js";
import { DecisionOverrideForm } from "./DecisionOverrideForm.js";

interface ReviewDetailProps {
  workspaceId: string;
  decision: DecisionDetail;
  onApprove: () => void | Promise<void>;
  onReject: (reason?: string) => void | Promise<void>;
  onUndo: () => void | Promise<void>;
  onDecisionChanged: () => void | Promise<void>;
}

function detailStatusTone(status: DecisionDetail["status"]): BadgeTone {
  switch (status) {
    case "suggested":
      return "teal";
    case "needs_review":
      return "orange";
    case "failed":
      return "red";
    case "auto_applied":
    case "approved":
      return "green";
    case "undone":
      return "blue";
    case "rejected":
      return "warm";
    default:
      return "blue";
  }
}

function rationaleRecord(decision: DecisionDetail): Record<string, unknown> {
  return decision.rationale ?? {};
}

function pageRefs(value: unknown): Array<{ id: string; title: string | null }> {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") return { id: item, title: null };
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      return typeof record.id === "string"
        ? {
            id: record.id,
            title: typeof record.title === "string" ? record.title : null,
          }
        : null;
    })
    .filter((item): item is { id: string; title: string | null } =>
      Boolean(item),
    );
}

export function ReviewDetail({
  workspaceId,
  decision,
  onApprove,
  onReject,
  onUndo,
  onDecisionChanged,
}: ReviewDetailProps) {
  const { t } = useTranslation(["review", "common"]);
  const [submitting, setSubmitting] = useState<
    "approve" | "reject" | "undo" | null
  >(null);
  const [rejectMode, setRejectMode] = useState(false);
  const [rejectReason, setRejectReason] = useState("");

  const resolved =
    decision.status === "approved" ||
    decision.status === "rejected" ||
    decision.status === "auto_applied" ||
    decision.status === "undone" ||
    decision.status === "noop";
  const canUndo =
    decision.status === "auto_applied" &&
    Boolean(decision.targetPageId && decision.proposedRevisionId) &&
    (decision.action === "create" ||
      decision.action === "update" ||
      decision.action === "append");
  const destructive =
    decision.action === "delete" || decision.action === "merge";
  const rationale = rationaleRecord(decision);
  const mergeSourcePages = pageRefs(rationale.sourcePages);
  const deletePageTitle =
    typeof rationale.pageTitle === "string" ? rationale.pageTitle : null;

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

  const doUndo = async () => {
    setSubmitting("undo");
    try {
      await onUndo();
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
            <Badge
              tone={detailStatusTone(decision.status)}
              size="sm"
              className={`review-badge review-badge-${decision.status}`}
            >
              {t(`badge.${decision.status}`, { defaultValue: decision.status })}
            </Badge>
            <span className="review-action-chip">
              {t(`action.${decision.action}`, {
                defaultValue: decision.action,
              })}
            </span>
            <span>
              {t("confidence")}: {Math.round(decision.confidence * 100)}%
            </span>
            <span>
              {t("source")}: {decision.ingestion.sourceName}
            </span>
            {decision.origin === "scheduled" && (
              <span className="review-origin-chip">
                <CalendarClock size={11} aria-hidden="true" />
                {t("origin.scheduled", {
                  defaultValue: "Scheduled Agent",
                })}
              </span>
            )}
          </div>
        </div>
        <div className="review-detail-links">
          {decision.targetPage && (
            <Link
              to={`/pages/${decision.targetPage.id}`}
              className="review-detail-link"
            >
              <FileText size={12} aria-hidden="true" />
              {t("viewInWiki", { defaultValue: "View in wiki" })}
            </Link>
          )}
          <Link
            to={`/ingestions/${decision.ingestion.id}`}
            className="review-detail-link"
          >
            <ExternalLink size={12} aria-hidden="true" />
            {t("detail.viewFullDetail")}
          </Link>
          {decision.scheduledRunId && (
            <Link
              to={`/settings/scheduled-agent?run=${decision.scheduledRunId}`}
              className="review-detail-link"
            >
              <CalendarClock size={12} aria-hidden="true" />
              {t("detail.viewScheduledRun", {
                defaultValue: "View scheduled run",
              })}
            </Link>
          )}
        </div>
      </div>

      {decision.conflict && (
        <div className="review-conflict-banner">
          <div className="review-conflict-title">
            <AlertTriangle size={14} aria-hidden="true" />
            {t("conflict.bannerTitle")}
          </div>
          <div className="review-conflict-body">
            {t("conflict.bannerBody", {
              editedAt: new Date(
                decision.conflict.humanEditedAt,
              ).toLocaleString(),
            })}
            {decision.conflict.humanRevisionNote && (
              <>
                {" "}
                <em>&ldquo;{decision.conflict.humanRevisionNote}&rdquo;</em>
              </>
            )}
          </div>
          <div className="review-conflict-hint">
            {t("conflict.approveWarning")}
          </div>
        </div>
      )}

      {decision.reason && (
        <div className="review-detail-section">
          <div className="review-detail-label">
            <Sparkles size={12} aria-hidden="true" />
            {t("reason")}
          </div>
          <div className="review-detail-reason">{decision.reason}</div>
        </div>
      )}

      {!resolved && !destructive && (
        <DecisionOverrideForm
          workspaceId={workspaceId}
          decision={decision}
          onSaved={onDecisionChanged}
        />
      )}

      {destructive && (
        <div className="review-conflict-banner">
          <div className="review-conflict-title">
            <AlertTriangle size={14} aria-hidden="true" />
            {t("destructive.title", { defaultValue: "Destructive change" })}
          </div>
          <div className="review-conflict-body">
            {decision.action === "delete" ? (
              <>
                <Trash2 size={13} aria-hidden="true" />{" "}
                {t("destructive.deleteBody", {
                  title:
                    deletePageTitle ??
                    decision.targetPage?.title ??
                    t("common:untitled"),
                  defaultValue:
                    "This will move the selected page and its children to trash.",
                })}
              </>
            ) : (
              <>
                {t("destructive.mergeBody", {
                  title: decision.targetPage?.title ?? t("common:untitled"),
                  count: mergeSourcePages.length,
                  defaultValue:
                    "This will promote the merged revision on the canonical page and move source pages to trash.",
                })}
                {mergeSourcePages.length > 0 && (
                  <ul className="review-destructive-list">
                    {mergeSourcePages.map((page) => (
                      <li key={page.id}>
                        <Link to={`/pages/${page.id}`}>
                          {page.title ?? page.id}
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
          <div className="review-conflict-hint">
            {t("destructive.warning", {
              defaultValue: "This approval cannot be undone in v1.",
            })}
          </div>
        </div>
      )}

      {decision.proposedRevision?.diffMd ? (
        <div className="review-detail-section">
          <div className="review-detail-label">
            <FileText size={12} aria-hidden="true" />
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
          <div className="review-detail-label">
            <FileText size={12} aria-hidden="true" />
            {t("proposedContent")}
          </div>
          <pre className="review-content-preview">
            {decision.proposedRevision.contentMd}
          </pre>
        </div>
      ) : (
        <div className="review-detail-section">
          <div className="review-detail-label">
            <FileText size={12} aria-hidden="true" />
            {t("normalizedText")}
          </div>
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
                  <X size={13} aria-hidden="true" />
                  {t("common:cancel")}
                </button>
                <button
                  className="btn btn-danger"
                  onClick={doReject}
                  disabled={submitting === "reject"}
                >
                  <X size={13} aria-hidden="true" />
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
                <X size={13} aria-hidden="true" />
                {t("reject")}
              </button>
              <button
                className="btn btn-primary"
                onClick={doApprove}
                disabled={submitting !== null}
              >
                <Check size={13} aria-hidden="true" />
                {submitting === "approve" ? t("approving") : t("approve")}
              </button>
            </>
          )}
        </div>
      )}

      {canUndo && (
        <div className="review-detail-actions">
          <button
            className="btn btn-secondary"
            onClick={doUndo}
            disabled={submitting !== null}
          >
            <RotateCcw size={13} aria-hidden="true" />
            {submitting === "undo"
              ? t("undoing", { defaultValue: "Undoing..." })
              : t("undo", { defaultValue: "Undo" })}
          </button>
        </div>
      )}
    </div>
  );
}
