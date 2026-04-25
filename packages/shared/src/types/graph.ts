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
  displayPredicate?: string | null;
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
  displayPredicate?: string | null;
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

export interface EntityAliasDto {
  id: string;
  entityId: string;
  alias: string;
  normalizedAlias: string;
  status: "active" | "rejected";
  similarityScore: number | null;
  matchMethod: string | null;
  sourcePageId: string | null;
  sourcePageTitle: string | null;
  createdByExtractionId: string | null;
  createdAt: string;
  rejectedAt: string | null;
  rejectedByUserId: string | null;
}
