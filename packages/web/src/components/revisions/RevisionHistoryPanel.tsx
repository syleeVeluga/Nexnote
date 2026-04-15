import { useState, useEffect, useCallback, useRef } from "react";
import {
  pages as pagesApi,
  type RevisionSummary,
  type RevisionDiffDto,
} from "../../lib/api-client.js";
import { DiffViewer } from "./DiffViewer.js";

interface RevisionHistoryPanelProps {
  workspaceId: string;
  pageId: string;
  currentRevisionId: string | null;
  onClose: () => void;
  onRollback: () => void;
}

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

export function RevisionHistoryPanel({
  workspaceId,
  pageId,
  currentRevisionId,
  onClose,
  onRollback,
}: RevisionHistoryPanelProps) {
  const [revisions, setRevisions] = useState<RevisionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [diff, setDiff] = useState<RevisionDiffDto | null | "empty">(null);
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
        // First revision has no diff — show empty
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
          err instanceof Error ? err.message : "Rollback failed",
        );
      } finally {
        rollingRef.current = false;
        setRolling(false);
      }
    },
    [workspaceId, pageId, onRollback],
  );

  const diffData = diff === "empty" ? null : diff;
  const diffOpen = diff !== null;

  return (
    <>
      <div className="revision-panel">
        <div className="revision-panel-header">
          <h2>History</h2>
          <button className="btn-close-panel" onClick={onClose}>
            &times;
          </button>
        </div>

        <div className="revision-list">
          {loading ? (
            <div className="revision-list-loading">Loading...</div>
          ) : revisions.length === 0 ? (
            <div className="revision-list-empty">No revisions</div>
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
                      {timeAgo(rev.createdAt)}
                      {isCurrent ? " (current)" : ""}
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
                    </div>
                  </div>

                  {rev.revisionNote && (
                    <div className="revision-note">{rev.revisionNote}</div>
                  )}

                  {rev.changedBlocks != null && (
                    <div className="revision-changed">
                      {rev.changedBlocks} block
                      {rev.changedBlocks !== 1 ? "s" : ""} changed
                    </div>
                  )}

                  {isFirst && (
                    <div className="revision-initial">Initial version</div>
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
                          View diff
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
                          {rolling ? "Rolling back..." : "Rollback"}
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
          title="Revision diff"
          onClose={() => setDiff(null)}
        />
      )}
    </>
  );
}
