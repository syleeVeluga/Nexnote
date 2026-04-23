import {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
  lazy,
  Suspense,
} from "react";
import { useTranslation } from "react-i18next";
import ForceGraph2D from "react-force-graph-2d";
import type { NodeObject, LinkObject } from "react-force-graph-2d";
import type {
  EntityType,
  GraphNode,
  GraphEdge,
  GraphData,
} from "@nexnote/shared";
import { pages as pagesApi } from "../../lib/api-client.js";
import { resolveSupportedLocale } from "../../i18n/locale.js";
import { NodeInspector } from "./NodeInspector.js";
import { getPredicateDisplayLabel } from "./predicate-label.js";
import {
  buildGraphFilterCandidates,
  filterGraphData,
  getFocusedNeighborhood,
  hasActiveGraphFilters,
  type GraphViewFilters,
} from "./graph-helpers.js";

// Lazy-load 3D graph to avoid adding Three.js weight to the initial bundle
const ForceGraph3D = lazy(() => import("react-force-graph-3d"));

interface GraphPanelProps {
  workspaceId: string;
  pageId: string;
  onClose: () => void;
  onNavigateToPage: (pageId: string) => void;
}

const DEFAULT_PANEL_WIDTH = 760;
const MIN_PANEL_WIDTH = 280;
const MAX_PANEL_WIDTH_RATIO = 0.8;

export const NODE_COLORS: Record<EntityType, string> = {
  person: "#4f46e5",
  organization: "#059669",
  concept: "#d97706",
  technology: "#7c3aed",
  location: "#dc2626",
  event: "#0891b2",
  other: "#6b7280",
};

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

function getNodeColor(type: string): string {
  return (
    (NODE_COLORS as Record<string, string>)[type.toLowerCase()] ??
    NODE_COLORS.other
  );
}

function withOpacity(color: string, opacity: number): string {
  const normalized = color.trim();
  if (!normalized.startsWith("#") || normalized.length !== 7) {
    return color;
  }

  const r = Number.parseInt(normalized.slice(1, 3), 16);
  const g = Number.parseInt(normalized.slice(3, 5), 16);
  const b = Number.parseInt(normalized.slice(5, 7), 16);

  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

export function GraphPanel({
  workspaceId,
  pageId,
  onClose,
  onNavigateToPage,
}: GraphPanelProps) {
  const { t, i18n } = useTranslation(["editor", "common"]);
  const locale = resolveSupportedLocale(i18n.resolvedLanguage ?? i18n.language);
  const [depth, setDepth] = useState<1 | 2>(1);
  const [mode, setMode] = useState<"2d" | "3d">("2d");
  const [minConfidence, setMinConfidence] = useState(0);
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null);
  const [hoveredEntityId, setHoveredEntityId] = useState<string | null>(null);
  const [activeEntityTypes, setActiveEntityTypes] = useState<string[]>([]);
  const [activePredicates, setActivePredicates] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
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

  useEffect(() => {
    filtersInitializedRef.current = false;
    setSelectedEntityId(null);
    setHoveredEntityId(null);
    setActiveEntityTypes([]);
    setActivePredicates([]);
  }, [workspaceId, pageId]);

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
    pagesApi
      .graph(workspaceId, pageId, {
        depth,
        limit: 250,
        minConfidence,
        locale,
      })
      .then((res) => setGraphData(res))
      .catch((err) => {
        setError(err instanceof Error ? err.message : t("noGraphData"));
        setGraphData(null);
      })
      .finally(() => setLoading(false));
  }, [workspaceId, pageId, depth, minConfidence, locale, t]);

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
      return surviving.length > 0 || nextTypes.length === 0 ? surviving : nextTypes;
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
      minConfidence,
    }),
    [activeEntityTypes, activePredicates, minConfidence],
  );

  const visibleGraph = useMemo(
    () => (graphData ? filterGraphData(graphData, graphFilters) : null),
    [graphData, graphFilters],
  );

  const focusState = useMemo(
    () =>
      visibleGraph
        ? getFocusedNeighborhood(visibleGraph, selectedEntityId, hoveredEntityId)
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

  const predicateLabels = useMemo(
    () => {
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
    },
    [filterCandidates.predicates, graphData?.edges, t],
  );

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
      ctx.fillStyle = node.isCenter ? "#1d4ed8" : color;
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

      ctx.font = `${node.isCenter ? "bold " : ""}${fontSize}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillStyle = "#1f2937";
      ctx.fillText(label, node.x ?? 0, (node.y ?? 0) + size + 2 / globalScale);
      ctx.restore();
    },
    [focusState, isNodeDimmed, selectedEntityId],
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

  const nodeColor3D = useCallback(
    (node: NodeObject) => {
      const n = node as GNode;
      const baseColor = n.isCenter
        ? "#1d4ed8"
        : getNodeColor(n.type ?? "other");
      return isNodeDimmed(n.id) ? withOpacity(baseColor, 0.22) : baseColor;
    },
    [isNodeDimmed],
  );

  const linkColor3D = useCallback(
    (link: LinkObject) =>
      isEdgeDimmed((link as GLink).id)
        ? "rgba(203, 213, 225, 0.24)"
        : "#94a3b8",
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

      <div className="graph-toolbar">
        <div className="graph-controls">
          <span className="graph-controls-label">{t("graphDepth")}:</span>
          <button
            className={`depth-btn${depth === 1 ? " active" : ""}`}
            onClick={() => setDepth(1)}
          >
            1
          </button>
          <button
            className={`depth-btn${depth === 2 ? " active" : ""}`}
            onClick={() => setDepth(2)}
          >
            2
          </button>
          <span className="graph-controls-sep" />
          <span className="graph-controls-label">{t("graphConfidence")}:</span>
          <label className="graph-range-control">
            <input
              type="range"
              min="0"
              max="1"
              step="0.1"
              value={minConfidence}
              onChange={(e) => setMinConfidence(Number(e.target.value))}
              aria-label={t("graphConfidence")}
            />
            <span className="graph-range-value">{minConfidence.toFixed(1)}</span>
          </label>
          <span className="graph-controls-sep" />
          <button
            className={`depth-btn${mode === "2d" ? " active" : ""}`}
            onClick={() => setMode("2d")}
          >
            2D
          </button>
          <button
            className={`depth-btn${mode === "3d" ? " active" : ""}`}
            onClick={() => setMode("3d")}
          >
            3D
          </button>
        </div>

        <div className="graph-filter-groups">
          <div className="graph-filter-group">
            <span className="graph-controls-label">{t("graphEntityTypes")}:</span>
            <div className="graph-chip-list">
              {filterCandidates.entityTypes.map((item) => (
                <button
                  key={item.value}
                  className={`graph-chip${activeEntityTypes.includes(item.value) ? " active" : ""}`}
                  onClick={() => toggleEntityType(item.value)}
                  aria-pressed={activeEntityTypes.includes(item.value)}
                >
                  {item.value}
                  <span className="graph-chip-count">{item.count}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="graph-filter-group">
            <span className="graph-controls-label">{t("graphPredicates")}:</span>
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
      </div>

      <div className="graph-meta-bar">
        <span>{t("graphVisibleNodes", { count: visibleGraph?.nodes.length ?? 0 })}</span>
        <span>{t("graphVisibleEdges", { count: visibleGraph?.edges.length ?? 0 })}</span>
        <span className={`graph-meta-pill${filtersApplied ? " active" : ""}`}>
          {filtersApplied ? t("graphFiltersApplied") : t("graphFiltersInactive")}
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
          <div className="graph-empty">{t("noGraphData")}</div>
        ) : !hasVisibleData ? (
          <div className="graph-empty">{t("graphNoFilteredData")}</div>
        ) : mode === "2d" ? (
          <>
            <ForceGraph2D
              graphData={forceGraphData}
              width={dimensions.width}
              height={dimensions.height}
              onNodeClick={(node) => setSelectedEntityId((node as GNode).id)}
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
        ) : (
          <Suspense
            fallback={<div className="graph-empty">{t("common:loading")}</div>}
          >
            <ForceGraph3D
              graphData={forceGraphData}
              width={dimensions.width}
              height={dimensions.height}
              onNodeClick={(node) => setSelectedEntityId((node as GNode).id)}
              onNodeHover={(node) =>
                setHoveredEntityId(node ? (node as GNode).id : null)
              }
              nodeLabel="label"
              nodeColor={nodeColor3D}
              nodeVal={(node) => (node as GNode).val ?? 1}
              linkColor={linkColor3D}
              linkWidth={(link) =>
                Math.max(((link as GLink).confidence ?? 0.5) * 2, 0.75)
              }
              linkDirectionalArrowLength={4}
              linkDirectionalArrowRelPos={1}
              cooldownTicks={200}
            />
          </Suspense>
        )}
      </div>

      {selectedEntityId && (
        <NodeInspector
          workspaceId={workspaceId}
          entityId={selectedEntityId}
          currentPageId={pageId}
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
