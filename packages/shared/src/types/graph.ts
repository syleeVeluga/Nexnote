export interface GraphNode {
  id: string;
  label: string;
  type: string;
  isCenter: boolean;
  pageCount: number;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  predicate: string;
  confidence: number;
  sourcePageId: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  meta: {
    pageId: string;
    depth: number;
    totalNodes: number;
    totalEdges: number;
    truncated: boolean;
  };
}
