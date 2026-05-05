import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import ForceGraph2D from "react-force-graph-2d";
import type {
  ForceGraphMethods,
  LinkObject,
  NodeObject,
} from "react-force-graph-2d";
import type { GraphNode, GraphEdge, GraphData } from "@wekiflow/shared";
import {
  folders as foldersApi,
  pages as pagesApi,
} from "../../lib/api-client.js";
import { resolveSupportedLocale } from "../../i18n/locale.js";
import { NodeInspector } from "./NodeInspector.js";
import { getNodeColor } from "./graph-colors.js";
import { getPredicateDisplayLabel } from "./predicate-label.js";
import {
  buildGraphFilterCandidates,
  filterGraphData,
  getFocusedNeighborhood,
  hasActiveGraphFilters,
  type GraphViewFilters,
} from "./graph-helpers.js";

type GraphPanelProps =
  | {
      mode: "page";
      workspaceId: string;
      pageId: string;
      onClose: () => void;
      onNavigateToPage: (pageId: string) => void;
    }
  | {
      mode: "folder";
      workspaceId: string;
      folderId: string;
      onClose: () => void;
      onNavigateToPage: (pageId: string) => void;
    };

const DEFAULT_PANEL_WIDTH = 760;
const MIN_PANEL_WIDTH = 280;
const MAX_PANEL_WIDTH_RATIO = 0.8;
const MIN_GRAPH_CONFIDENCE = 0;
const DEFAULT_NODE_LIMIT_BY_DEPTH: Record<1 | 2, number> = {
  1: 500,
  2: 1000,
};
const NODE_LIMIT_PRESETS = [100, 200, 500, 1000] as const;

type GNode = NodeObject<{
  id: string;
  label: string;
  type: string;
  isCenter: boolean;
  val: number;
}>;

type GLink = LinkObject<
  {
    id: string;
    label: string;
    type: string;
    isCenter: boolean;
    val: number;
  },
  {
    id: string;
    predicate: string;
    confidence: number;
  }
>;

type EntityChipStyle = CSSProperties & {
  "--graph-chip-color": string;
  "--graph-chip-bg": string;
  "--graph-chip-bg-hover": string;
  "--graph-chip-border": string;
  "--graph-chip-count-bg": string;
};

function getEntityChipStyle(type: string): EntityChipStyle {
  const color = getNodeColor(type);

  return {
    "--graph-chip-color": color,
    "--graph-chip-bg": `${color}14`,
    "--graph-chip-bg-hover": `${color}1f`,
    "--graph-chip-border": `${color}4d`,
    "--graph-chip-count-bg": `${color}1a`,
  };
}

export function GraphPanel(props: GraphPanelProps) {
  const { workspaceId, onClose, onNavigateToPage } = props;
  const { t, i18n } = useTranslation(["editor", "common", "pages"]);
  const locale = resolveSupportedLocale(i18n.resolvedLanguage ?? i18n.language);
  const [depth, setDepth] = useState<1 | 2>(1);
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null);
  const [hoveredEntityId, setHoveredEntityId] = useState<string | null>(null);
  const [activeEntityTypes, setActiveEntityTypes] = useState<string[]>([]);
  const [activePredicates, setActivePredicates] = useState<string[]>([]);
  const [showNodeLabels, setShowNodeLabels] = useState(true);
  const [nodeLimit, setNodeLimit] = useState<number>(
    DEFAULT_NODE_LIMIT_BY_DEPTH[1],
  );
  const [nodeLimitMode, setNodeLimitMode] = useState<"auto" | "custom">("auto");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const forceGraphRef = useRef<ForceGraphMethods<GNode, GLink> | undefined>(
    undefined,
  );
  const [dimensions, setDimensions] = useState({
    width: DEFAULT_PANEL_WIDTH,
    height: 400,
  });
  const [panelWidth, setPanelWidth] = useState(DEFAULT_PANEL_WIDTH);
  const [isResizing, setIsResizing] = useState(false);
  const resizeStateRef = useRef<{ startX: number; startWidth: number } | null>(
    null,
  );
  const filtersInitializedRef = useRef(false);
  const targetId = props.mode === "page" ? props.pageId : props.folderId;
  const currentPageId = props.mode === "page" ? props.pageId : null;
  const emptyGraphMessage =
    props.mode === "folder"
      ? t("pages:wiki.folderGraphEmpty")
      : t("noGraphData");

  useEffect(() => {
    filtersInitializedRef.current = false;
    setSelectedEntityId(null);
    setHoveredEntityId(null);
    setActiveEntityTypes([]);
    setActivePredicates([]);
  }, [workspaceId, props.mode, targetId]);

  const handleResizePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      resizeStateRef.current = { startX: e.clientX, startWidth: panelWidth };
      setIsResizing(true);
      (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    },
    [panelWidth],
  );

  const handleResizePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const state = resizeStateRef.current;
      if (!state) return;
      const delta = state.startX - e.clientX;
      const maxWidth = Math.max(
        MIN_PANEL_WIDTH,
        window.innerWidth * MAX_PANEL_WIDTH_RATIO,
      );
      const next = Math.min(
        Math.max(state.startWidth + delta, MIN_PANEL_WIDTH),
        maxWidth,
      );
      setPanelWidth((prev) => (prev === next ? prev : next));
    },
    [],
  );

  const handleResizePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      resizeStateRef.current = null;
      setIsResizing(false);
      if ((e.currentTarget as HTMLDivElement).hasPointerCapture(e.pointerId)) {
        (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
      }
    },
    [],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          setDimensions((prev) =>
            prev.width === width && prev.height === height
              ? prev
              : { width, height },
          );
        }
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setLoading(true);
    setError(null);
    const opts = {
      depth,
      limit: nodeLimit,
      minConfidence: MIN_GRAPH_CONFIDENCE,
      locale,
    };
    const fetcher =
      props.mode === "page"
        ? () => pagesApi.graph(workspaceId, props.pageId, opts)
        : () => foldersApi.graph(workspaceId, props.folderId, opts);

    fetcher()
      .then((res) => setGraphData(res))
      .catch((err) => {
        setError(err instanceof Error ? err.message : t("noGraphData"));
        setGraphData(null);
      })
      .finally(() => setLoading(false));
  }, [workspaceId, props.mode, targetId, depth, nodeLimit, locale, t]);

  const filterCandidates = useMemo(
    () =>
      graphData
        ? buildGraphFilterCandidates(graphData)
        : { entityTypes: [], predicates: [] },
    [graphData],
  );

  useEffect(() => {
    if (!graphData) return;

    const nextTypes = filterCandidates.entityTypes.map((item) => item.value);
    const nextPredicates = filterCandidates.predicates.map(
      (item) => item.value,
    );

    if (!filtersInitializedRef.current) {
      setActiveEntityTypes(nextTypes);
      setActivePredicates(nextPredicates);
      filtersInitializedRef.current = true;
      return;
    }

    setActiveEntityTypes((prev) => {
      if (prev.length === 0) return prev;
      const surviving = prev.filter((value) => nextTypes.includes(value));
      return surviving.length > 0 || nextTypes.length === 0
        ? surviving
        : nextTypes;
    });

    setActivePredicates((prev) => {
      if (prev.length === 0) return prev;
      const surviving = prev.filter((value) => nextPredicates.includes(value));
      return surviving.length > 0 || nextPredicates.length === 0
        ? surviving
        : nextPredicates;
    });
  }, [graphData, filterCandidates]);

  const graphFilters = useMemo<GraphViewFilters>(
    () => ({
      activeEntityTypes,
      activePredicates,
      minConfidence: MIN_GRAPH_CONFIDENCE,
    }),
    [activeEntityTypes, activePredicates],
  );

  const visibleGraph = useMemo(
    () => (graphData ? filterGraphData(graphData, graphFilters) : null),
    [graphData, graphFilters],
  );

  const focusState = useMemo(
    () =>
      visibleGraph
        ? getFocusedNeighborhood(
            visibleGraph,
            selectedEntityId,
            hoveredEntityId,
          )
        : {
            activeNodeId: null,
            nodeIds: new Set<string>(),
            edgeIds: new Set<string>(),
          },
    [visibleGraph, selectedEntityId, hoveredEntityId],
  );

  const filtersApplied = useMemo(
    () => hasActiveGraphFilters(graphFilters, filterCandidates),
    [graphFilters, filterCandidates],
  );

  const predicateLabels = useMemo(() => {
    const apiLabels = new Map<string, string>();
    for (const edge of graphData?.edges ?? []) {
      if (edge.displayPredicate) {
        apiLabels.set(edge.predicate, edge.displayPredicate);
      }
    }

    return new Map(
      filterCandidates.predicates.map((item) => [
        item.value,
        getPredicateDisplayLabel(t, item.value, apiLabels.get(item.value)),
      ]),
    );
  }, [filterCandidates.predicates, graphData?.edges, t]);

  useEffect(() => {
    if (!selectedEntityId || !visibleGraph) return;
    if (!visibleGraph.nodes.some((node) => node.id === selectedEntityId)) {
      setSelectedEntityId(null);
    }
  }, [visibleGraph, selectedEntityId]);

  const toggleEntityType = useCallback((type: string) => {
    setActiveEntityTypes((prev) =>
      prev.includes(type)
        ? prev.filter((value) => value !== type)
        : [...prev, type],
    );
  }, []);

  const togglePredicate = useCallback((predicate: string) => {
    setActivePredicates((prev) =>
      prev.includes(predicate)
        ? prev.filter((value) => value !== predicate)
        : [...prev, predicate],
    );
  }, []);

  const handleDepthChange = useCallback(
    (nextDepth: 1 | 2) => {
      setDepth(nextDepth);
      if (nodeLimitMode === "auto") {
        setNodeLimit(DEFAULT_NODE_LIMIT_BY_DEPTH[nextDepth]);
      }
    },
    [nodeLimitMode],
  );

  const handleNodeLimitChange = useCallback((nextLimit: number) => {
    setNodeLimitMode("custom");
    setNodeLimit(nextLimit);
  }, []);

  // Keep the graph data structurally stable so react-force-graph does not
  // restart the force simulation on every hover/selection change. Visual
  // state (dim / focus / selected) is derived from focusState + selection
  // inside the paint callbacks below.
  const forceGraphData = useMemo(() => {
    if (!visibleGraph) return { nodes: [] as GNode[], links: [] as GLink[] };

    const nodes: GNode[] = visibleGraph.nodes.map((n: GraphNode) => ({
      id: n.id,
      label: n.label,
      type: n.type,
      isCenter: n.isCenter,
      val: Math.max(n.pageCount, 1),
    }));

    const links: GLink[] = visibleGraph.edges.map((e: GraphEdge) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      predicate: predicateLabels.get(e.predicate) ?? e.predicate,
      confidence: e.confidence,
    }));

    return { nodes, links };
  }, [visibleGraph, predicateLabels]);

  useEffect(() => {
    const fg = forceGraphRef.current;
    if (!fg || forceGraphData.nodes.length === 0) return;
    fg.d3Force("charge")?.strength(-18);
    fg.d3Force("link")?.distance(18);
    fg.d3ReheatSimulation();
  }, [forceGraphData]);

  const isNodeDimmed = useCallback(
    (id: string) =>
      focusState.activeNodeId !== null && !focusState.nodeIds.has(id),
    [focusState],
  );

  const isEdgeDimmed = useCallback(
    (id: string) =>
      focusState.activeNodeId !== null && !focusState.edgeIds.has(id),
    [focusState],
  );

  const paintNode = useCallback(
    (node: GNode, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const label = node.label ?? "";
      const fontSize = Math.max(10 / globalScale, 1.5);
      const size = Math.sqrt(node.val ?? 1) * 3;
      const color = getNodeColor(node.type);

      const isFocused = focusState.nodeIds.has(node.id);
      const isDimmed = isNodeDimmed(node.id);
      const isSelected = node.id === selectedEntityId;

      ctx.save();
      ctx.globalAlpha = isDimmed ? 0.22 : 1;
      ctx.beginPath();
      ctx.arc(node.x ?? 0, node.y ?? 0, size, 0, 2 * Math.PI);
      ctx.fillStyle = color;
      ctx.fill();

      if (node.isCenter) {
        ctx.strokeStyle = "#93c5fd";
        ctx.lineWidth = 1.5 / globalScale;
        ctx.stroke();
      }

      if (isFocused && !isSelected && !node.isCenter) {
        ctx.beginPath();
        ctx.arc(
          node.x ?? 0,
          node.y ?? 0,
          size + 2 / globalScale,
          0,
          2 * Math.PI,
        );
        ctx.strokeStyle = "rgba(15, 23, 42, 0.35)";
        ctx.lineWidth = 1 / globalScale;
        ctx.stroke();
      }

      if (isSelected) {
        ctx.beginPath();
        ctx.arc(
          node.x ?? 0,
          node.y ?? 0,
          size + 3 / globalScale,
          0,
          2 * Math.PI,
        );
        ctx.strokeStyle = "#1d4ed8";
        ctx.lineWidth = 2 / globalScale;
        ctx.stroke();
      }

      if (showNodeLabels) {
        ctx.font = `${node.isCenter ? "bold " : ""}${fontSize}px sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillStyle = "#1f2937";
        ctx.fillText(
          label,
          node.x ?? 0,
          (node.y ?? 0) + size + 2 / globalScale,
        );
      }
      ctx.restore();
    },
    [focusState, isNodeDimmed, selectedEntityId, showNodeLabels],
  );

  const paintLink = useCallback(
    (link: GLink, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const src = link.source as GNode;
      const tgt = link.target as GNode;
      if (!src || !tgt || src.x == null || tgt.x == null) return;
      const label = link.predicate ?? "";
      const isEdgeFocused = focusState.edgeIds.has(link.id);
      if (!label || (!isEdgeFocused && globalScale < 1.8)) return;

      const isDimmed = isEdgeDimmed(link.id);

      const fontSize = Math.max(8 / globalScale, 1.5);
      const dx = (tgt.x ?? 0) - (src.x ?? 0);
      const dy = (tgt.y ?? 0) - (src.y ?? 0);
      const angle = Math.atan2(dy, dx);
      const midX = ((src.x ?? 0) + (tgt.x ?? 0)) / 2;
      const midY = ((src.y ?? 0) + (tgt.y ?? 0)) / 2;

      ctx.save();
      ctx.globalAlpha = isDimmed ? 0.28 : 1;
      ctx.translate(midX, midY);
      const displayAngle =
        Math.abs(angle) > Math.PI / 2 ? angle + Math.PI : angle;
      ctx.rotate(displayAngle);

      ctx.font = `${fontSize}px sans-serif`;
      const textW = ctx.measureText(label).width;
      const pad = 1.5 / globalScale;
      const offsetY = -(fontSize + pad * 2 + 2 / globalScale);

      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.fillRect(
        -textW / 2 - pad,
        offsetY - pad,
        textW + pad * 2,
        fontSize + pad * 2,
      );

      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillStyle = "#6b7280";
      ctx.fillText(label, 0, offsetY);
      ctx.restore();
    },
    [focusState, isEdgeDimmed],
  );

  const linkColor2D = useCallback(
    (link: GLink) =>
      isEdgeDimmed(link.id) ? "rgba(203, 213, 225, 0.28)" : "#94a3b8",
    [isEdgeDimmed],
  );

  const hasServerData = (graphData?.nodes.length ?? 0) > 0;
  const hasVisibleData = (visibleGraph?.nodes.length ?? 0) > 0;

  return (
    <div
      className={`graph-panel${isResizing ? " is-resizing" : ""}${selectedEntityId ? " has-selection" : ""}`}
      style={{ width: panelWidth, minWidth: MIN_PANEL_WIDTH }}
    >
      <div
        className="graph-panel-resizer"
        role="separator"
        aria-orientation="vertical"
        onPointerDown={handleResizePointerDown}
        onPointerMove={handleResizePointerMove}
        onPointerUp={handleResizePointerUp}
        onPointerCancel={handleResizePointerUp}
      />
      <div className="graph-panel-header">
        <h2>{t("graph")}</h2>
        <button className="btn-close-panel" onClick={onClose}>
          &times;
        </button>
      </div>

      <div className="graph-content">
        <aside className="graph-toolbar">
          <div className="graph-controls">
            <div className="graph-control-group">
              <span className="graph-controls-label">{t("graphDepth")}:</span>
              <div className="graph-button-row">
                <button
                  className={`depth-btn${depth === 1 ? " active" : ""}`}
                  onClick={() => handleDepthChange(1)}
                  aria-pressed={depth === 1}
                  aria-label={`${t("graphDepth")} 1`}
                >
                  1
                </button>
                <button
                  className={`depth-btn${depth === 2 ? " active" : ""}`}
                  onClick={() => handleDepthChange(2)}
                  aria-pressed={depth === 2}
                  aria-label={`${t("graphDepth")} 2`}
                >
                  2
                </button>
              </div>
            </div>

            <div className="graph-control-group">
              <span className="graph-controls-label">
                {t("graphNodeLimit")}:
              </span>
              <div className="graph-button-row">
                {NODE_LIMIT_PRESETS.map((limit) => (
                  <button
                    key={limit}
                    className={`depth-btn${nodeLimit === limit ? " active" : ""}`}
                    onClick={() => handleNodeLimitChange(limit)}
                    aria-pressed={nodeLimit === limit}
                    aria-label={`${t("graphNodeLimit")} ${limit}`}
                  >
                    {limit}
                  </button>
                ))}
              </div>
            </div>

            <div className="graph-control-group">
              <span className="graph-controls-label">
                {t("graphNodeLabels")}:
              </span>
              <div className="graph-button-row">
                <button
                  className={`depth-btn${showNodeLabels ? " active" : ""}`}
                  onClick={() => setShowNodeLabels((value) => !value)}
                  aria-pressed={showNodeLabels}
                >
                  {showNodeLabels
                    ? t("graphNodeLabelsOn")
                    : t("graphNodeLabelsOff")}
                </button>
              </div>
            </div>
          </div>

          <div className="graph-filter-groups">
            <div className="graph-filter-group">
              <span className="graph-controls-label">
                {t("graphEntityTypes")}:
              </span>
              <div className="graph-chip-list">
                {filterCandidates.entityTypes.map((item) => (
                  <button
                    key={item.value}
                    className={`graph-chip graph-chip-entity${activeEntityTypes.includes(item.value) ? " active" : ""}`}
                    style={getEntityChipStyle(item.value)}
                    onClick={() => toggleEntityType(item.value)}
                    aria-pressed={activeEntityTypes.includes(item.value)}
                  >
                    <span
                      className="graph-chip-swatch"
                      style={{ backgroundColor: getNodeColor(item.value) }}
                      aria-hidden="true"
                    />
                    {item.value}
                    <span className="graph-chip-count">{item.count}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="graph-filter-group">
              <span className="graph-controls-label">
                {t("graphPredicates")}:
              </span>
              <div className="graph-chip-list">
                {filterCandidates.predicates.map((item) => (
                  <button
                    key={item.value}
                    className={`graph-chip${activePredicates.includes(item.value) ? " active" : ""}`}
                    onClick={() => togglePredicate(item.value)}
                    aria-pressed={activePredicates.includes(item.value)}
                  >
                    {predicateLabels.get(item.value) ?? item.value}
                    <span className="graph-chip-count">{item.count}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </aside>

        <div className="graph-visual">
          <div className="graph-meta-bar">
            <span>
              {t("graphVisibleNodes", {
                count: visibleGraph?.nodes.length ?? 0,
              })}
            </span>
            <span>
              {t("graphVisibleEdges", {
                count: visibleGraph?.edges.length ?? 0,
              })}
            </span>
            <span
              className={`graph-meta-pill${filtersApplied ? " active" : ""}`}
            >
              {filtersApplied
                ? t("graphFiltersApplied")
                : t("graphFiltersInactive")}
            </span>
          </div>

          <div className="graph-container" ref={containerRef}>
            {loading ? (
              <div className="graph-empty">{t("common:loading")}</div>
            ) : error ? (
              <div className="graph-empty" style={{ color: "#dc2626" }}>
                {error}
              </div>
            ) : !hasServerData ? (
              <div className="graph-empty">{emptyGraphMessage}</div>
            ) : !hasVisibleData ? (
              <div className="graph-empty">{t("graphNoFilteredData")}</div>
            ) : (
              <>
                <ForceGraph2D
                  ref={forceGraphRef}
                  graphData={forceGraphData}
                  width={dimensions.width}
                  height={dimensions.height}
                  onNodeClick={(node) =>
                    setSelectedEntityId((node as GNode).id)
                  }
                  onNodeHover={(node) =>
                    setHoveredEntityId(node ? (node as GNode).id : null)
                  }
                  nodeCanvasObject={paintNode}
                  nodePointerAreaPaint={(
                    node: GNode,
                    color: string,
                    ctx: CanvasRenderingContext2D,
                  ) => {
                    const size = Math.sqrt(node.val ?? 1) * 3;
                    ctx.beginPath();
                    ctx.arc(node.x ?? 0, node.y ?? 0, size + 2, 0, 2 * Math.PI);
                    ctx.fillStyle = color;
                    ctx.fill();
                  }}
                  linkColor={linkColor2D}
                  linkWidth={(link: GLink) =>
                    Math.max((link.confidence ?? 0.5) * 2, 0.75)
                  }
                  linkDirectionalArrowLength={3}
                  linkDirectionalArrowRelPos={1}
                  linkCanvasObjectMode={() => "after" as const}
                  linkCanvasObject={paintLink}
                  cooldownTicks={200}
                />
                {graphData?.meta.truncated && (
                  <div className="graph-truncated-notice">
                    {t("graphTruncated", { limit: graphData.meta.totalNodes })}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {selectedEntityId && (
        <NodeInspector
          workspaceId={workspaceId}
          entityId={selectedEntityId}
          currentPageId={currentPageId}
          graphData={visibleGraph}
          onClose={() => setSelectedEntityId(null)}
          onSelectEntity={setSelectedEntityId}
          onNavigateToPage={onNavigateToPage}
          getTypeColor={getNodeColor}
        />
      )}
    </div>
  );
}
