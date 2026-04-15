import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useTranslation } from "react-i18next";
import ForceGraph2D from "react-force-graph-2d";
import type { NodeObject, LinkObject } from "react-force-graph-2d";
import {
  pages as pagesApi,
  type GraphNode,
  type GraphEdge,
  type GraphData,
} from "../../lib/api-client.js";

interface GraphPanelProps {
  workspaceId: string;
  pageId: string;
  onClose: () => void;
}

const NODE_COLORS: Record<string, string> = {
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
  { id: string; label: string; type: string; isCenter: boolean; val: number },
  { predicate: string; confidence: number }
>;

function getNodeColor(type: string): string {
  return NODE_COLORS[type.toLowerCase()] ?? NODE_COLORS.other;
}

export function GraphPanel({
  workspaceId,
  pageId,
  onClose,
}: GraphPanelProps) {
  const { t } = useTranslation(["editor", "common"]);
  const [depth, setDepth] = useState<1 | 2>(1);
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 380, height: 400 });

  // Observe container size for responsive rendering
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          setDimensions({ width, height });
        }
      }
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // Fetch graph data
  useEffect(() => {
    setLoading(true);
    setError(null);

    pagesApi
      .graph(workspaceId, pageId, { depth, limit: 60 })
      .then((res) => {
        setGraphData(res);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to load graph");
        setGraphData(null);
      })
      .finally(() => setLoading(false));
  }, [workspaceId, pageId, depth]);

  // Transform API data into force-graph format
  const forceGraphData = useMemo(() => {
    if (!graphData) return { nodes: [] as GNode[], links: [] as GLink[] };

    const nodes: GNode[] = graphData.nodes.map((n: GraphNode) => ({
      id: n.id,
      label: n.label,
      type: n.type,
      isCenter: n.isCenter,
      val: Math.max(n.pageCount, 1),
    }));

    const links: GLink[] = graphData.edges.map((e: GraphEdge) => ({
      source: e.source,
      target: e.target,
      predicate: e.predicate,
      confidence: e.confidence,
    }));

    return { nodes, links };
  }, [graphData]);

  // Custom node rendering: draw circle + label
  const paintNode = useCallback(
    (node: GNode, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const label = node.label ?? "";
      const fontSize = Math.max(10 / globalScale, 1.5);
      const size = Math.sqrt(node.val ?? 1) * 3;
      const color = getNodeColor(node.type ?? "other");

      // Circle
      ctx.beginPath();
      ctx.arc(node.x ?? 0, node.y ?? 0, size, 0, 2 * Math.PI);
      ctx.fillStyle = node.isCenter ? "#1d4ed8" : color;
      ctx.fill();

      if (node.isCenter) {
        ctx.strokeStyle = "#93c5fd";
        ctx.lineWidth = 1.5 / globalScale;
        ctx.stroke();
      }

      // Label
      ctx.font = `${node.isCenter ? "bold " : ""}${fontSize}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillStyle = "#1f2937";
      ctx.fillText(label, node.x ?? 0, (node.y ?? 0) + size + 2 / globalScale);
    },
    [],
  );

  // Custom link label rendering
  const paintLink = useCallback(
    (link: GLink, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const fontSize = Math.max(8 / globalScale, 1);
      const src = link.source as GNode;
      const tgt = link.target as GNode;
      if (!src || !tgt || src.x == null || tgt.x == null) return;

      const midX = ((src.x ?? 0) + (tgt.x ?? 0)) / 2;
      const midY = ((src.y ?? 0) + (tgt.y ?? 0)) / 2;

      ctx.font = `${fontSize}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#9ca3af";
      ctx.fillText(link.predicate ?? "", midX, midY);
    },
    [],
  );

  return (
    <div className="graph-panel">
      <div className="graph-panel-header">
        <h2>{t("graph")}</h2>
        <button className="btn-close-panel" onClick={onClose}>
          &times;
        </button>
      </div>

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
      </div>

      <div className="graph-container" ref={containerRef}>
        {loading ? (
          <div className="graph-empty">{t("common:loading")}</div>
        ) : error ? (
          <div className="graph-empty" style={{ color: "#dc2626" }}>
            {error}
          </div>
        ) : !graphData || graphData.nodes.length === 0 ? (
          <div className="graph-empty">{t("noGraphData")}</div>
        ) : (
          <>
            <ForceGraph2D
              graphData={forceGraphData}
              width={dimensions.width}
              height={dimensions.height}
              nodeCanvasObject={paintNode}
              nodePointerAreaPaint={(node: GNode, color: string, ctx: CanvasRenderingContext2D) => {
                const size = Math.sqrt(node.val ?? 1) * 3;
                ctx.beginPath();
                ctx.arc(node.x ?? 0, node.y ?? 0, size + 2, 0, 2 * Math.PI);
                ctx.fillStyle = color;
                ctx.fill();
              }}
              linkColor={() => "#d1d5db"}
              linkWidth={(link: GLink) =>
                Math.max((link.confidence ?? 0.5) * 2, 0.5)
              }
              linkDirectionalArrowLength={3}
              linkDirectionalArrowRelPos={1}
              linkCanvasObjectMode={() => "after" as const}
              linkCanvasObject={paintLink}
              cooldownTicks={80}
              enableZoomInteraction={true}
              enablePanInteraction={true}
            />
            {graphData.meta.truncated && (
              <div className="graph-truncated-notice">
                {t("graphTruncated", {
                  limit: graphData.meta.totalNodes,
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
