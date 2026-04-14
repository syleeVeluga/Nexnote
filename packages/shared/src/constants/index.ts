export const ACTOR_TYPES = ["user", "ai", "system"] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export const PAGE_STATUSES = ["draft", "published", "archived"] as const;
export type PageStatus = (typeof PAGE_STATUSES)[number];

export const REVISION_SOURCES = [
  "editor",
  "ingest_api",
  "rollback",
  "publish",
] as const;
export type RevisionSource = (typeof REVISION_SOURCES)[number];

export const INGESTION_STATUSES = [
  "pending",
  "processing",
  "completed",
  "failed",
] as const;
export type IngestionStatus = (typeof INGESTION_STATUSES)[number];

export const INGESTION_ACTIONS = [
  "create",
  "update",
  "append",
  "noop",
  "needs_review",
] as const;
export type IngestionAction = (typeof INGESTION_ACTIONS)[number];

export const WORKSPACE_ROLES = ["owner", "admin", "editor", "viewer"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export const AI_PROVIDERS = ["openai", "gemini"] as const;
export type AIProvider = (typeof AI_PROVIDERS)[number];

export const MODEL_RUN_MODES = [
  "route_decision",
  "patch_generation",
  "triple_extraction",
] as const;
export type ModelRunMode = (typeof MODEL_RUN_MODES)[number];

export const MODEL_RUN_STATUSES = [
  "pending",
  "running",
  "success",
  "failed",
] as const;
export type ModelRunStatus = (typeof MODEL_RUN_STATUSES)[number];

export const ENTITY_TYPES = [
  "person",
  "organization",
  "concept",
  "technology",
  "location",
  "event",
  "other",
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const TRIPLE_STATUSES = [
  "active",
  "deprecated",
  "rejected",
] as const;
export type TripleStatus = (typeof TRIPLE_STATUSES)[number];

export const CONFIDENCE = {
  AUTO_APPLY: 0.85,
  SUGGESTION_MIN: 0.6,
} as const;

export const QUEUE_NAMES = {
  INGESTION: "ingestion",
  EXTRACTION: "extraction",
  PUBLISH: "publish",
  SEARCH: "search",
} as const;

export const JOB_NAMES = {
  ROUTE_CLASSIFIER: "route-classifier",
  PATCH_GENERATOR: "patch-generator",
  TRIPLE_EXTRACTOR: "triple-extractor",
  PUBLISH_RENDERER: "publish-renderer",
  SEARCH_INDEX_UPDATER: "search-index-updater",
} as const;
