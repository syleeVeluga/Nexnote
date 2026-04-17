import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  pages as pagesApi,
  type RevisionSummary,
  type RevisionDiffDto,
} from "../../lib/api-client.js";
import { timeAgo } from "../../lib/time-ago.js";
import { DiffViewer } from "./DiffViewer.js";
import { IngestionSourcePanel } from "./IngestionSourcePanel.js";

interface RevisionHistoryPanelProps {
  workspaceId: string;
  pageId: string;
  currentRevisionId: string | null;
  onClose: () => void;
  onRollback: () => void;
}

export function RevisionHistoryPanel({
  workspaceId,
  pageId,
  currentRevisionId,
  onClose,
  onRollback,
}: RevisionHistoryPanelProps) {
  const { t } = useTranslation(["editor", "common"]);
  const [revisions, setRevisions] = useState<RevisionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [diff, setDiff] = useState<RevisionDiffDto | null | "empty">(null);
  const [sourceDecisionId, setSourceDecisionId] = useState<string | null>(null);
  const [rolling, setRolling] = useState(false);
  const [rollbackError, setRollbackError] = useState<string | null>(null);
  const rollingRef = useRef(false);

  useEffect(() => {
    setLoading(true);
    pagesApi
      .listRevisions(workspaceId, pageId, { limit: 50 })
      .then((res) => setRevisions(res.data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [workspaceId, pageId, currentRevisionId]);

  const handleViewDiff = useCallback(
    async (revisionId: string) => {
      try {
        const res = await pagesApi.getRevisionDiff(
          workspaceId,
          pageId,
          revisionId,
        );
        setDiff(res.diff);
      } catch {
        setDiff("empty");
      }
    },
    [workspaceId, pageId],
  );

  const handleRollback = useCallback(
    async (revisionId: string) => {
      if (rollingRef.current) return;
      rollingRef.current = true;
      setRolling(true);
      setRollbackError(null);
      try {
        await pagesApi.rollbackRevision(workspaceId, pageId, revisionId);
        setSelectedId(null);
        onRollback();
      } catch (err) {
        setRollbackError(
          err instanceof Error ? err.message : t("rollbackFailed"),
        );
      } finally {
        rollingRef.current = false;
        setRolling(false);
      }
    },
    [workspaceId, pageId, onRollback, t],
  );

  const diffData = diff === "empty" ? null : diff;
  const diffOpen = diff !== null;

  return (
    <>
      <div className="revision-panel">
        <div className="revision-panel-header">
          <h2>{t("history")}</h2>
          <button className="btn-close-panel" onClick={onClose}>
            &times;
          </button>
        </div>

        <div className="revision-list">
          {loading ? (
            <div className="revision-list-loading">{t("common:loading")}</div>
          ) : revisions.length === 0 ? (
            <div className="revision-list-empty">{t("noRevisions")}</div>
          ) : (
            revisions.map((rev, idx) => {
              const isFirst = idx === revisions.length - 1;
              const isCurrent = rev.id === currentRevisionId;
              return (
                <div
                  key={rev.id}
                  className={`revision-entry${selectedId === rev.id ? " selected" : ""}`}
                  onClick={() => setSelectedId(rev.id)}
                >
                  <div className="revision-entry-header">
                    <span className="revision-time">
                      {timeAgo(rev.createdAt, t)}
                      {isCurrent ? ` ${t("current")}` : ""}
                    </span>
                    <div className="revision-badges">
                      <span
                        className={`badge-actor badge-actor-${rev.actorType}`}
                      >
                        {rev.actorType}
                      </span>
                      <span
                        className={`badge-source badge-source-${rev.source}`}
                      >
                        {rev.source}
                      </span>
                      {rev.sourceDecisionId && (
                        <span
                          className="badge-has-source"
                          title={t("viewSource")}
                          aria-label={t("viewSource")}
                        >
                          ⛓
                        </span>
                      )}
                    </div>
                  </div>

                  {rev.revisionNote && (
                    <div className="revision-note">{rev.revisionNote}</div>
                  )}

                  {rev.changedBlocks != null && (
                    <div className="revision-changed">
                      {t("blocksChanged", { count: rev.changedBlocks })}
                    </div>
                  )}

                  {isFirst && (
                    <div className="revision-initial">{t("initialVersion")}</div>
                  )}

                  {selectedId === rev.id && (
                    <div className="revision-actions">
                      {!isFirst && (
                        <button
                          className="btn-view-diff"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleViewDiff(rev.id);
                          }}
                        >
                          {t("viewDiff")}
                        </button>
                      )}
                      {rev.sourceDecisionId && (
                        <button
                          className="btn-view-source"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSourceDecisionId(rev.sourceDecisionId);
                          }}
                        >
                          {t("viewSource")}
                        </button>
                      )}
                      {!isCurrent && (
                        <button
                          className="btn-rollback"
                          disabled={rolling}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleRollback(rev.id);
                          }}
                        >
                          {rolling ? t("rollingBack") : t("rollback")}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
          {rollbackError && (
            <div className="revision-list-empty" style={{ color: "#dc2626" }}>
              {rollbackError}
            </div>
          )}
        </div>
      </div>

      {diffOpen && (
        <DiffViewer
          diffMd={diffData?.diffMd ?? ""}
          changedBlocks={diffData?.changedBlocks}
          title={t("revisionDiff")}
          onClose={() => setDiff(null)}
        />
      )}

      {sourceDecisionId && (
        <IngestionSourcePanel
          workspaceId={workspaceId}
          decisionId={sourceDecisionId}
          onClose={() => setSourceDecisionId(null)}
        />
      )}
    </>
  );
}
