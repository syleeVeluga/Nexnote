import type { GraphData, GraphNode } from "@nexnote/shared";

export interface GraphFilterOption {
  value: string;
  count: number;
}

export interface GraphFilterCandidates {
  entityTypes: GraphFilterOption[];
  predicates: GraphFilterOption[];
}

export interface GraphViewFilters {
  activeEntityTypes: string[];
  activePredicates: string[];
  minConfidence: number;
}

export interface GraphFocusState {
  activeNodeId: string | null;
  nodeIds: Set<string>;
  edgeIds: Set<string>;
}

export interface GraphRelation {
  edgeId: string;
  predicate: string;
  displayPredicate?: string | null;
  confidence: number;
  direction: "outgoing" | "incoming";
  entity: GraphNode;
}

function sortOptions(a: GraphFilterOption, b: GraphFilterOption) {
  if (b.count !== a.count) {
    return b.count - a.count;
  }

  return a.value.localeCompare(b.value);
}

function sortRelations(a: GraphRelation, b: GraphRelation) {
  const predicateOrder = a.predicate.localeCompare(b.predicate);
  if (predicateOrder !== 0) {
    return predicateOrder;
  }

  return a.entity.label.localeCompare(b.entity.label);
}

export function buildGraphFilterCandidates(
  graphData: GraphData,
): GraphFilterCandidates {
  const entityTypeCounts = new Map<string, number>();
  const predicateCounts = new Map<string, number>();

  for (const node of graphData.nodes) {
    entityTypeCounts.set(
      node.type,
      (entityTypeCounts.get(node.type) ?? 0) + 1,
    );
  }

  for (const edge of graphData.edges) {
    predicateCounts.set(
      edge.predicate,
      (predicateCounts.get(edge.predicate) ?? 0) + 1,
    );
  }

  return {
    entityTypes: [...entityTypeCounts.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort(sortOptions),
    predicates: [...predicateCounts.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort(sortOptions),
  };
}

export function filterGraphData(
  graphData: GraphData,
  filters: GraphViewFilters,
): GraphData {
  const allowedNodeTypes = new Set(filters.activeEntityTypes);
  const allowedPredicates = new Set(filters.activePredicates);
  const allowedNodeIds = new Set(
    graphData.nodes
      .filter((node) => allowedNodeTypes.has(node.type))
      .map((node) => node.id),
  );

  const visibleEdges = graphData.edges.filter(
    (edge) =>
      edge.confidence >= filters.minConfidence &&
      allowedPredicates.has(edge.predicate) &&
      allowedNodeIds.has(edge.source) &&
      allowedNodeIds.has(edge.target),
  );

  const connectedNodeIds = new Set<string>();
  for (const edge of visibleEdges) {
    connectedNodeIds.add(edge.source);
    connectedNodeIds.add(edge.target);
  }

  const visibleNodes = graphData.nodes.filter(
    (node) =>
      allowedNodeIds.has(node.id) &&
      (node.isCenter || connectedNodeIds.has(node.id)),
  );

  return {
    nodes: visibleNodes,
    edges: visibleEdges,
    meta: graphData.meta,
  };
}

export function hasActiveGraphFilters(
  filters: GraphViewFilters,
  candidates: GraphFilterCandidates,
) {
  return (
    filters.minConfidence > 0 ||
    filters.activeEntityTypes.length !== candidates.entityTypes.length ||
    filters.activePredicates.length !== candidates.predicates.length
  );
}

export function getFocusedNeighborhood(
  graphData: GraphData,
  selectedEntityId: string | null,
  hoveredEntityId: string | null,
): GraphFocusState {
  const activeNodeId = selectedEntityId ?? hoveredEntityId ?? null;
  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();

  if (
    !activeNodeId ||
    !graphData.nodes.some((node) => node.id === activeNodeId)
  ) {
    return { activeNodeId: null, nodeIds, edgeIds };
  }

  nodeIds.add(activeNodeId);

  for (const edge of graphData.edges) {
    if (edge.source !== activeNodeId && edge.target !== activeNodeId) {
      continue;
    }

    edgeIds.add(edge.id);
    nodeIds.add(edge.source);
    nodeIds.add(edge.target);
  }

  return { activeNodeId, nodeIds, edgeIds };
}

export function getEntityRelations(
  graphData: GraphData,
  entityId: string | null,
): { outgoing: GraphRelation[]; incoming: GraphRelation[] } {
  if (!entityId) {
    return { outgoing: [], incoming: [] };
  }

  const nodesById = new Map(graphData.nodes.map((node) => [node.id, node]));
  const outgoing: GraphRelation[] = [];
  const incoming: GraphRelation[] = [];

  for (const edge of graphData.edges) {
    if (edge.source === entityId) {
      const target = nodesById.get(edge.target);
      if (target) {
        outgoing.push({
          edgeId: edge.id,
          predicate: edge.predicate,
          displayPredicate: edge.displayPredicate ?? null,
          confidence: edge.confidence,
          direction: "outgoing",
          entity: target,
        });
      }
    }

    if (edge.target === entityId) {
      const source = nodesById.get(edge.source);
      if (source) {
        incoming.push({
          edgeId: edge.id,
          predicate: edge.predicate,
          displayPredicate: edge.displayPredicate ?? null,
          confidence: edge.confidence,
          direction: "incoming",
          entity: source,
        });
      }
    }
  }

  outgoing.sort(sortRelations);
  incoming.sort(sortRelations);

  return { outgoing, incoming };
}
