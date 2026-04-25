import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  pages as pagesApi,
  type EntityAliasDto,
  type EntityProvenance,
  type GraphData,
} from "../../lib/api-client.js";
import { resolveSupportedLocale } from "../../i18n/locale.js";
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
  const { t, i18n } = useTranslation(["editor", "common"]);
  const locale = resolveSupportedLocale(i18n.resolvedLanguage ?? i18n.language);
  const [detail, setDetail] = useState<EntityProvenance | null>(null);
  const [aliases, setAliases] = useState<EntityAliasDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [rejectingAliasId, setRejectingAliasId] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setErrorKey(null);
    setDetail(null);
    setAliases([]);

    Promise.all([
      pagesApi.entityProvenance(workspaceId, entityId, {
        limit: 5,
        locale,
        signal: controller.signal,
      }),
      pagesApi.entityAliases(workspaceId, entityId, {
        signal: controller.signal,
      }),
    ])
      .then(([provenance, aliasResult]) => {
        setDetail(provenance);
        setAliases(aliasResult.aliases);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        void err;
        setErrorKey("graphNodeInspectorLoadFailed");
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      });

    return () => controller.abort();
  }, [workspaceId, entityId, locale]);

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

  const activeAliases = aliases.filter((alias) => alias.status === "active");
  const rejectedAliases = aliases.filter(
    (alias) => alias.status === "rejected",
  );

  const handleRejectAlias = async (alias: EntityAliasDto) => {
    const confirmed = window.confirm(
      t("graphNodeInspectorUnaliasConfirm", { alias: alias.alias }),
    );
    if (!confirmed) return;
    setRejectingAliasId(alias.id);
    try {
      await pagesApi.rejectEntityAlias(workspaceId, entityId, alias.id);
      const refreshed = await pagesApi.entityAliases(workspaceId, entityId);
      setAliases(refreshed.aliases);
    } catch {
      window.alert(t("graphNodeInspectorUnaliasFailed"));
    } finally {
      setRejectingAliasId(null);
    }
  };

  return (
    <section
      className="node-inspector"
      aria-label={t("graphNodeInspectorAria")}
    >
      {loading ? (
        <div className="graph-empty">{t("common:loading")}</div>
      ) : errorKey ? (
        <div className="graph-empty" style={{ color: "#dc2626" }}>
          {t(errorKey)}
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
                <h4>{t("graphNodeInspectorAliases")}</h4>
                <span className="node-inspector-section-meta">
                  {t("graphNodeInspectorAliasCount", {
                    count: activeAliases.length,
                  })}
                </span>
              </div>

              {activeAliases.length === 0 && rejectedAliases.length === 0 ? (
                <div className="node-relation-empty">
                  {t("graphNodeInspectorNoAliases")}
                </div>
              ) : (
                <div className="node-alias-list">
                  {activeAliases.map((alias) => (
                    <div className="node-alias-row" key={alias.id}>
                      <div className="node-alias-copy">
                        <span className="node-alias-text">{alias.alias}</span>
                        <span className="node-alias-meta">
                          {alias.matchMethod
                            ? t("graphNodeInspectorAliasMethod", {
                                method: alias.matchMethod,
                              })
                            : t("graphNodeInspectorAliasManual")}
                          {alias.sourcePageTitle
                            ? ` / ${alias.sourcePageTitle}`
                            : ""}
                        </span>
                      </div>
                      <button
                        type="button"
                        className="node-alias-reject-btn"
                        onClick={() => void handleRejectAlias(alias)}
                        disabled={rejectingAliasId === alias.id}
                      >
                        {rejectingAliasId === alias.id
                          ? t("common:loading")
                          : t("graphNodeInspectorUnalias")}
                      </button>
                    </div>
                  ))}
                  {rejectedAliases.length > 0 && (
                    <details className="node-rejected-aliases">
                      <summary>
                        {t("graphNodeInspectorRejectedAliases", {
                          count: rejectedAliases.length,
                        })}
                      </summary>
                      {rejectedAliases.map((alias) => (
                        <div className="node-alias-row rejected" key={alias.id}>
                          <span className="node-alias-text">{alias.alias}</span>
                          <span className="node-alias-meta">
                            {alias.rejectedAt
                              ? new Date(alias.rejectedAt).toLocaleDateString()
                              : t("graphNodeInspectorRejected")}
                          </span>
                        </div>
                      ))}
                    </details>
                  )}
                </div>
              )}
            </div>

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
                          {getPredicateDisplayLabel(
                            t,
                            relation.predicate,
                            relation.displayPredicate,
                          )}
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
                          {getPredicateDisplayLabel(
                            t,
                            relation.predicate,
                            relation.displayPredicate,
                          )}
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
                                {getPredicateDisplayLabel(
                                  t,
                                  excerpt.predicate,
                                  excerpt.displayPredicate,
                                )}
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
