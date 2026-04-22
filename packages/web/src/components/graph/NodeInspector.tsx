import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  pages as pagesApi,
  type EntityProvenance,
  type GraphData,
} from "../../lib/api-client.js";
import { getEntityRelations } from "./graph-helpers.js";
import { getPredicateDisplayLabel } from "./predicate-label.js";

interface NodeInspectorProps {
  workspaceId: string;
  entityId: string;
  currentPageId: string;
  graphData: GraphData | null;
  onClose: () => void;
  onSelectEntity: (entityId: string) => void;
  onNavigateToPage: (pageId: string) => void;
  getTypeColor: (type: string) => string;
}

type ProvenancePage = EntityProvenance["sourcePages"][number];
type ProvenanceExcerpt = ProvenancePage["evidenceExcerpts"][number];

function truncateExcerpt(text: string, limit = 120) {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit).trimEnd()}...`;
}

export function NodeInspector({
  workspaceId,
  entityId,
  currentPageId,
  graphData,
  onClose,
  onSelectEntity,
  onNavigateToPage,
  getTypeColor,
}: NodeInspectorProps) {
  const { t } = useTranslation(["editor", "common"]);
  const [detail, setDetail] = useState<EntityProvenance | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setDetail(null);

    pagesApi
      .entityProvenance(workspaceId, entityId, {
        limit: 5,
        signal: controller.signal,
      })
      .then((res) => setDetail(res))
      .catch((err) => {
        if (controller.signal.aborted) return;
        void err;
        setError(t("graphNodeInspectorLoadFailed"));
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      });

    return () => controller.abort();
  }, [workspaceId, entityId, t]);

  const hiddenPageCount = useMemo(() => {
    if (!detail?.truncated) return 0;
    return Math.max(
      detail.entity.totalSourcePages - detail.sourcePages.length,
      0,
    );
  }, [detail]);

  const relations = useMemo(
    () =>
      graphData
        ? getEntityRelations(graphData, entityId)
        : { outgoing: [], incoming: [] },
    [graphData, entityId],
  );

  const totalDirectRelations =
    relations.outgoing.length + relations.incoming.length;

  return (
    <section
      className="node-inspector"
      aria-label={t("graphNodeInspectorAria")}
    >
      {loading ? (
        <div className="graph-empty">{t("common:loading")}</div>
      ) : error ? (
        <div className="graph-empty" style={{ color: "#dc2626" }}>
          {error}
        </div>
      ) : !detail ? (
        <div className="graph-empty">{t("graphNodeInspectorEmpty")}</div>
      ) : (
        <>
          <div className="node-inspector-header">
            <div>
              <div className="node-inspector-title-row">
                <h3>{detail.entity.canonicalName}</h3>
                <span
                  className="node-inspector-type-chip"
                  style={{
                    backgroundColor: `${getTypeColor(detail.entity.entityType)}1a`,
                    color: getTypeColor(detail.entity.entityType),
                    borderColor: `${getTypeColor(detail.entity.entityType)}40`,
                  }}
                >
                  {detail.entity.entityType}
                </span>
              </div>
              <p className="node-inspector-subtitle">
                {t("graphNodeInspectorSubtitle", {
                  pageCount: detail.entity.totalSourcePages,
                  relationCount: detail.entity.totalActiveTriples,
                })}
              </p>
            </div>
            <button className="btn-close-panel" onClick={onClose}>
              &times;
            </button>
          </div>

          <div className="node-inspector-body">
            <div className="node-inspector-section">
              <div className="node-inspector-section-header">
                <h4>{t("graphNodeInspectorRelations")}</h4>
                <span className="node-inspector-section-meta">
                  {t("graphNodeInspectorRelationsCount", {
                    count: totalDirectRelations,
                  })}
                </span>
              </div>

              <div className="node-relations-grid">
                <div className="node-relation-group">
                  <div className="node-relation-group-title">
                    {t("graphNodeInspectorOutgoing")}
                  </div>
                  {relations.outgoing.length === 0 ? (
                    <div className="node-relation-empty">
                      {t("graphNodeInspectorNoOutgoing")}
                    </div>
                  ) : (
                    relations.outgoing.map((relation) => (
                      <button
                        key={relation.edgeId}
                        className="node-relation-row"
                        onClick={() => onSelectEntity(relation.entity.id)}
                      >
                        <span className="node-relation-predicate">
                          {getPredicateDisplayLabel(t, relation.predicate)}
                        </span>
                        <span className="node-relation-target">
                          {relation.entity.label}
                        </span>
                        <span
                          className="node-inspector-type-chip"
                          style={{
                            backgroundColor: `${getTypeColor(relation.entity.type)}1a`,
                            color: getTypeColor(relation.entity.type),
                            borderColor: `${getTypeColor(relation.entity.type)}40`,
                          }}
                        >
                          {relation.entity.type}
                        </span>
                      </button>
                    ))
                  )}
                </div>

                <div className="node-relation-group">
                  <div className="node-relation-group-title">
                    {t("graphNodeInspectorIncoming")}
                  </div>
                  {relations.incoming.length === 0 ? (
                    <div className="node-relation-empty">
                      {t("graphNodeInspectorNoIncoming")}
                    </div>
                  ) : (
                    relations.incoming.map((relation) => (
                      <button
                        key={relation.edgeId}
                        className="node-relation-row"
                        onClick={() => onSelectEntity(relation.entity.id)}
                      >
                        <span className="node-relation-predicate">
                          {getPredicateDisplayLabel(t, relation.predicate)}
                        </span>
                        <span className="node-relation-target">
                          {relation.entity.label}
                        </span>
                        <span
                          className="node-inspector-type-chip"
                          style={{
                            backgroundColor: `${getTypeColor(relation.entity.type)}1a`,
                            color: getTypeColor(relation.entity.type),
                            borderColor: `${getTypeColor(relation.entity.type)}40`,
                          }}
                        >
                          {relation.entity.type}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              </div>
            </div>

            <div className="node-inspector-section">
              <div className="node-inspector-section-header">
                <h4>{t("graphNodeInspectorSourcePages")}</h4>
              </div>

              {detail.sourcePages.length === 0 ? (
                <div className="graph-empty">
                  {t("graphNodeInspectorNoPages")}
                </div>
              ) : (
                detail.sourcePages.map((page: ProvenancePage) => {
                  const preview = page.evidenceExcerpts[0]?.excerpt ?? null;
                  const isCurrentPage = page.pageId === currentPageId;
                  return (
                    <div className="node-source-row" key={page.pageId}>
                      <div className="node-source-copy">
                        <div className="node-source-title">{page.title}</div>
                        <div className="node-source-reason">
                          {t("graphNodeInspectorPageReason", {
                            count: page.activeTripleCount,
                          })}
                        </div>
                        {preview && (
                          <div className="node-source-excerpt">
                            {truncateExcerpt(preview)}
                          </div>
                        )}
                      </div>
                      <button
                        className="node-source-open-btn"
                        onClick={() => onNavigateToPage(page.pageId)}
                        disabled={isCurrentPage}
                      >
                        {isCurrentPage
                          ? t("graphNodeInspectorAlreadyOpen")
                          : t("graphNodeInspectorOpenPage")}
                      </button>
                    </div>
                  );
                })
              )}
            </div>

            <details className="node-inspector-evidence">
              <summary>{t("graphNodeInspectorEvidence")}</summary>
              <div className="node-inspector-evidence-list">
                {detail.sourcePages.some(
                  (page: ProvenancePage) => page.evidenceExcerpts.length > 0,
                ) ? (
                  detail.sourcePages.map((page: ProvenancePage) => (
                    <div className="node-evidence-group" key={page.pageId}>
                      <div className="node-evidence-page">{page.title}</div>
                      {page.evidenceExcerpts.length > 0 ? (
                        page.evidenceExcerpts.map(
                          (excerpt: ProvenanceExcerpt) => (
                            <div
                              className="node-evidence-row"
                              key={excerpt.tripleId}
                            >
                              <span className="node-evidence-predicate">
                                {getPredicateDisplayLabel(t, excerpt.predicate)}
                              </span>
                              <span>{excerpt.excerpt}</span>
                            </div>
                          ),
                        )
                      ) : (
                        <div className="node-evidence-empty">
                          {t("graphNodeInspectorNoPageEvidence")}
                        </div>
                      )}
                    </div>
                  ))
                ) : (
                  <div className="node-evidence-empty">
                    {t("graphNodeInspectorNoEvidence")}
                  </div>
                )}
              </div>
            </details>

            {detail.truncated && hiddenPageCount > 0 && (
              <div className="node-inspector-footer">
                {t("graphNodeInspectorMorePages", { count: hiddenPageCount })}
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
