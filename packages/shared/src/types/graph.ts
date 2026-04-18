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

export interface EntityProvenanceExcerpt {
  tripleId: string;
  predicate: string;
  excerpt: string;
  spanStart: number;
  spanEnd: number;
}

export interface EntityProvenanceSourcePage {
  pageId: string;
  title: string;
  slug: string;
  activeTripleCount: number;
  lastUpdatedAt: string;
  lastAiUpdatedAt: string | null;
  evidenceExcerpts: EntityProvenanceExcerpt[];
}

export interface EntityProvenance {
  entity: {
    id: string;
    canonicalName: string;
    entityType: string;
    totalSourcePages: number;
    totalActiveTriples: number;
  };
  sourcePages: EntityProvenanceSourcePage[];
  truncated: boolean;
}
