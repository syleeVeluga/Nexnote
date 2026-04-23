import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useWorkspace } from "../hooks/use-workspace.js";
import { useTimeAgo } from "../hooks/use-time-ago.js";
import {
  ApiError,
  decisions as decisionsApi,
  ingestions as ingestionsApi,
  type DecisionCandidate,
  type DecisionDetail,
  type DecisionSummary,
  type IngestionDetail,
} from "../lib/api-client.js";
import { classifyLine } from "../components/revisions/DiffViewer.js";
import { dispatchDecisionCountsUpdated } from "../lib/decision-events.js";

interface DecisionPanelProps {
  workspaceId: string;
  summary: DecisionSummary;
  initiallyExpanded: boolean;
  onResolved: () => void | Promise<void>;
}

function CandidateRow({
  candidate,
  isSelected,
}: {
  candidate: DecisionCandidate;
  isSelected: boolean;
}) {
  const { t } = useTranslation(["review"]);
  const href = `/pages/${candidate.id}`;
  const sources = candidate.matchSources ?? [];

  return (
    <li className={`ingestion-candidate${isSelected ? " selected" : ""}`}>
      <div className="ingestion-candidate-main">
        <Link to={href} className="ingestion-candidate-title">
          {candidate.title}
        </Link>
        {isSelected && (
          <span className="ingestion-candidate-selected-chip">
            {t("detail.selectedTarget")}
          </span>
        )}
      </div>
      {sources.length > 0 && (
        <div className="ingestion-candidate-sources">
          {sources.map((s) => (
            <span
              key={s}
              className={`ingestion-match-chip ingestion-match-${s}`}
              title={t(`detail.matchSource.${s}`, { defaultValue: s })}
            >
              {t(`detail.matchSource.${s}`, { defaultValue: s })}
            </span>
          ))}
        </div>
      )}
      <span className="ingestion-candidate-slug">{candidate.slug}</span>
    </li>
  );
}

function DecisionPanel({
  workspaceId,
  summary,
  initiallyExpanded,
  onResolved,
}: DecisionPanelProps) {
  const { t } = useTranslation(["review", "common"]);
  const [detail, setDetail] = useState<DecisionDetail | null>(null);
  const [loading, setLoading] = useState(initiallyExpanded);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<"approve" | "reject" | null>(null);
  const [rejectMode, setRejectMode] = useState(false);
  const [rejectReason, setRejectReason] = useState("");

  const loadDetail = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await decisionsApi.get(workspaceId, summary.id);
      setDetail(res);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : t("detail.loadFailed"),
      );
    } finally {
      setLoading(false);
    }
  }, [workspaceId, summary.id, t]);

  useEffect(() => {
    if (!initiallyExpanded) return;
    void loadDetail();
  }, [initiallyExpanded, loadDetail]);

  const resolved =
    summary.status === "approved" ||
    summary.status === "rejected" ||
    summary.status === "auto_applied" ||
    summary.status === "noop";

  const doApprove = async () => {
    setSubmitting("approve");
    try {
      await decisionsApi.approve(workspaceId, summary.id);
      await Promise.all([loadDetail(), onResolved()]);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : t("actionFailed"));
    } finally {
      setSubmitting(null);
    }
  };

  const doReject = async () => {
    setSubmitting("reject");
    try {
      await decisionsApi.reject(
        workspaceId,
        summary.id,
        rejectReason.trim() || undefined,
      );
      setRejectMode(false);
      setRejectReason("");
      await Promise.all([loadDetail(), onResolved()]);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : t("actionFailed"));
    } finally {
      setSubmitting(null);
    }
  };

  const candidates =
    detail?.candidates ?? summary.rationale?.candidates ?? [];
  const diffLines = detail?.proposedRevision?.diffMd
    ? detail.proposedRevision.diffMd.split("\n")
    : [];

  return (
    <section className="ingestion-decision-panel">
      <header className="ingestion-decision-header">
        <div className="ingestion-decision-title">
          {summary.action === "create"
            ? t("newPage", {
                title:
                  summary.proposedPageTitle ??
                  t("common:untitled"),
              })
            : detail?.targetPage?.title ??
              summary.proposedPageTitle ??
              t("common:untitled")}
        </div>
        <div className="ingestion-decision-meta">
          <span className={`review-badge review-badge-${summary.status}`}>
            {t(`badge.${summary.status}`, { defaultValue: summary.status })}
          </span>
          <span className="review-action-chip">
            {t(`action.${summary.action}`, { defaultValue: summary.action })}
          </span>
          <span>
            {t("confidence")}: {Math.round(summary.confidence * 100)}%
          </span>
          <span className="ingestion-decision-time">
            {new Date(summary.createdAt).toLocaleString()}
          </span>
        </div>
      </header>

      {loading && (
        <div className="ingestion-decision-loading">{t("loading")}</div>
      )}
      {error && <div className="ingestion-decision-error">{error}</div>}

      {(detail?.conflict ?? summary.rationale?.conflict) && (
        <div className="review-conflict-banner">
          <div className="review-conflict-title">
            ⚠ {t("conflict.bannerTitle")}
          </div>
          <div className="review-conflict-body">
            {t("conflict.bannerBody", {
              editedAt: new Date(
                (detail?.conflict ?? summary.rationale?.conflict)!
                  .humanEditedAt,
              ).toLocaleString(),
            })}
            {(detail?.conflict ?? summary.rationale?.conflict)!
              .humanRevisionNote && (
              <>
                {" "}
                <em>
                  &ldquo;
                  {
                    (detail?.conflict ?? summary.rationale?.conflict)!
                      .humanRevisionNote
                  }
                  &rdquo;
                </em>
              </>
            )}
          </div>
          <div className="review-conflict-hint">
            {t("conflict.approveWarning")}
          </div>
        </div>
      )}

      {summary.rationale?.reason && (
        <div className="review-detail-section">
          <div className="review-detail-label">{t("reason")}</div>
          <div className="review-detail-reason">{summary.rationale.reason}</div>
        </div>
      )}

      <div className="review-detail-section">
        <div className="review-detail-label">
          {t("detail.candidates")}
          <span className="review-detail-label-sub">
            {" "}
            ({candidates.length})
          </span>
        </div>
        {candidates.length === 0 ? (
          <div className="ingestion-candidates-empty">
            {t("detail.noCandidates")}
          </div>
        ) : (
          <ul className="ingestion-candidate-list">
            {candidates.map((c) => (
              <CandidateRow
                key={c.id}
                candidate={c}
                isSelected={
                  c.id ===
                  (detail?.targetPageId ?? summary.targetPageId ?? null)
                }
              />
            ))}
          </ul>
        )}
      </div>

      {detail?.proposedRevision?.diffMd && (
        <div className="review-detail-section">
          <div className="review-detail-label">
            {t("proposedDiff")}
            {detail.proposedRevision.changedBlocks != null && (
              <span className="review-detail-label-sub">
                {" "}
                ({detail.proposedRevision.changedBlocks} blocks)
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
      )}

      {!resolved && (
        <div className="review-detail-actions">
          {rejectMode ? (
            <div className="review-reject-form">
              <label htmlFor={`reject-${summary.id}`}>
                {t("rejectReason")}
              </label>
              <textarea
                id={`reject-${summary.id}`}
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
    </section>
  );
}

export function IngestionDetailPage() {
  const { t } = useTranslation(["review", "common"]);
  const { ingestionId } = useParams<{ ingestionId: string }>();
  const { current } = useWorkspace();
  const navigate = useNavigate();
  const timeAgo = useTimeAgo();
  const [data, setData] = useState<IngestionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const workspaceId = current?.id;

  const loadIngestion = useCallback(async () => {
    if (!workspaceId || !ingestionId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await ingestionsApi.get(workspaceId, ingestionId);
      setData(res);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : t("detail.loadFailed"),
      );
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [workspaceId, ingestionId, t]);

  useEffect(() => {
    void loadIngestion();
  }, [loadIngestion]);

  const handleOnResolved = useCallback(async () => {
    if (!workspaceId) return;
    const res = await decisionsApi.counts(workspaceId);
    dispatchDecisionCountsUpdated({ workspaceId, counts: res.counts });
    await loadIngestion();
  }, [workspaceId, loadIngestion]);

  const handleDownload = useCallback(async () => {
    if (!workspaceId || !ingestionId) return;
    setDownloading(true);
    setDownloadError(null);
    try {
      await ingestionsApi.downloadOriginal(workspaceId, ingestionId);
    } catch (err) {
      setDownloadError(
        err instanceof Error ? err.message : t("detail.downloadFailed"),
      );
    } finally {
      setDownloading(false);
    }
  }, [workspaceId, ingestionId, t]);

  const sortedDecisions = useMemo(() => {
    if (!data) return [] as DecisionSummary[];
    // Most-recent decision first; that one expands by default.
    return [...data.decisions].sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }, [data]);

  const hasOriginal = Boolean(data?.hasOriginal);

  if (!current) return null;

  return (
    <div className="ingestion-detail-page">
      <div className="ingestion-detail-breadcrumb">
        <button
          className="ingestion-breadcrumb-link"
          onClick={() => navigate("/review")}
        >
          &larr; {t("detail.backToReview")}
        </button>
      </div>

      {loading ? (
        <div className="ingestion-detail-empty">{t("loading")}</div>
      ) : error || !data ? (
        <div className="ingestion-detail-empty">
          {error ?? t("detail.notFound")}
        </div>
      ) : (
        <>
          <header className="ingestion-detail-header">
            <h1>
              {data.titleHint ??
                t("detail.untitledFromSource", {
                  source: data.sourceName,
                })}
            </h1>
            <div className="ingestion-detail-meta">
              <span className="ingestion-meta-chip">
                {t("source")}: {data.sourceName}
              </span>
              {data.externalRef && (
                <span className="ingestion-meta-chip">
                  ref: {data.externalRef}
                </span>
              )}
              <span className="ingestion-meta-chip">
                {t("detail.contentType")}: {data.contentType}
              </span>
              <span className={`review-badge review-badge-${data.status}`}>
                {data.status}
              </span>
              <span className="ingestion-meta-time">
                {t("receivedAt")} · {timeAgo(data.receivedAt)}
                {" · "}
                {new Date(data.receivedAt).toLocaleString()}
              </span>
            </div>
          </header>

          <section className="ingestion-detail-section">
            <h2>{t("detail.payload")}</h2>
            <div className="ingestion-detail-actions">
              {hasOriginal && (
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={handleDownload}
                  disabled={downloading}
                >
                  {downloading
                    ? t("common:loading")
                    : t("detail.downloadOriginal")}
                </button>
              )}
              {downloadError && (
                <div className="source-panel-error">{downloadError}</div>
              )}
            </div>
            {data.normalizedText ? (
              <details className="review-detail-collapsible" open>
                <summary>{t("normalizedText")}</summary>
                <pre className="review-content-preview">
                  {data.normalizedText}
                </pre>
              </details>
            ) : null}
            <details className="review-detail-collapsible">
              <summary>{t("rawPayload")}</summary>
              <pre className="review-content-preview">
                {JSON.stringify(data.rawPayload, null, 2)}
              </pre>
            </details>
          </section>

          <section className="ingestion-detail-section">
            <h2>
              {t("detail.decisions")}
              <span className="review-detail-label-sub">
                {" "}
                ({sortedDecisions.length})
              </span>
            </h2>
            {sortedDecisions.length === 0 ? (
              <div className="ingestion-detail-empty">
                {t("detail.noDecisions")}
              </div>
            ) : (
              <div className="ingestion-decision-list">
                {sortedDecisions.map((dec, idx) => (
                  <DecisionPanel
                    key={dec.id}
                    workspaceId={workspaceId!}
                    summary={dec}
                    initiallyExpanded={idx === 0}
                    onResolved={handleOnResolved}
                  />
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
