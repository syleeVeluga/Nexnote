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

export const IMPORT_SOURCE_NAMES = {
  MANUAL_UPLOAD: "manual-upload",
  WEB_URL: "web-url",
  MANUAL_PASTE: "manual-paste",
} as const;
export type ImportSourceName =
  (typeof IMPORT_SOURCE_NAMES)[keyof typeof IMPORT_SOURCE_NAMES];

export const INGESTION_ACTIONS = [
  "create",
  "update",
  "append",
  "noop",
  "needs_review",
] as const;
export type IngestionAction = (typeof INGESTION_ACTIONS)[number];

// Decision status — the three-band routing outcome plus human-review transitions.
// Set by the route-classifier at decision-creation time and mutated by the
// approve/reject APIs. See CONFIDENCE below for the thresholds.
export const DECISION_STATUSES = [
  "auto_applied",  // confidence >= AUTO_APPLY, already applied
  "suggested",     // SUGGESTION_MIN <= confidence < AUTO_APPLY, awaiting human
  "needs_review",  // confidence < SUGGESTION_MIN, low-trust
  "approved",      // human approved a suggested decision
  "rejected",      // human rejected the decision
  "noop",          // AI decided no action was needed
  "failed",        // patch-generator failed to produce a revision
] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

export const WORKSPACE_ROLES = ["owner", "admin", "editor", "viewer"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export const AI_PROVIDERS = ["openai", "gemini"] as const;
export type AIProvider = (typeof AI_PROVIDERS)[number];

export const AI_MODELS = {
  OPENAI_DEFAULT: "gpt-5.4",
  GEMINI_DEFAULT: "gemini-3.1-pro",
} as const;

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
  "page_deleted",
] as const;
export type TripleStatus = (typeof TRIPLE_STATUSES)[number];

export const CONFIDENCE = {
  AUTO_APPLY: 0.85,
  SUGGESTION_MIN: 0.6,
} as const;

// Per-model input budget (in tokens) for large-context-first prompt assembly.
// `inputTokenBudget` is the *total* input window we're willing to consume
// (leaves headroom for provider overhead + streaming). Callers further subtract
// `MODE_OUTPUT_RESERVE[mode]` and any fixed system-prompt cost before
// distributing the remainder across dynamic slots (existing/incoming/etc.).
// `safetyMarginRatio` is applied multiplicatively after slot allocation to
// absorb tokenizer drift from our character-based estimator.
export interface ModelContextBudget {
  inputTokenBudget: number;
  safetyMarginRatio: number;
}

export const MODEL_CONTEXT_BUDGETS: Record<string, ModelContextBudget> = {
  "openai:gpt-5.4": { inputTokenBudget: 180_000, safetyMarginRatio: 0.9 },
  "openai:gpt-5.4-pro": { inputTokenBudget: 400_000, safetyMarginRatio: 0.9 },
  "gemini:gemini-3.1-pro": {
    inputTokenBudget: 800_000,
    safetyMarginRatio: 0.9,
  },
};

// Conservative fallback for unregistered provider/model pairs. Chosen small
// enough that any modern frontier model will accept it without 413s.
export const DEFAULT_MODEL_CONTEXT_BUDGET: ModelContextBudget = {
  inputTokenBudget: 32_000,
  safetyMarginRatio: 0.85,
};

// Output token reserve per mode — mirrors the `maxTokens` currently passed on
// each worker's AIRequest so budgeting math matches actual request shape.
// triple_extraction caps at ~40 triples × ~200 chars ≈ 2k tokens in practice,
// so 4k leaves comfortable headroom while freeing input budget.
export const MODE_OUTPUT_RESERVE: Record<ModelRunMode, number> = {
  route_decision: 2_048,
  patch_generation: 8_192,
  triple_extraction: 4_096,
};

export function getModelContextBudget(
  provider: AIProvider,
  model: string,
): ModelContextBudget {
  return (
    MODEL_CONTEXT_BUDGETS[`${provider}:${model}`] ?? DEFAULT_MODEL_CONTEXT_BUDGET
  );
}

export const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 5000 },
} as const;

export const QUEUE_NAMES = {
  INGESTION: "ingestion",
  PATCH: "patch",
  EXTRACTION: "extraction",
  PUBLISH: "publish",
  SEARCH: "search",
} as const;

export const QUEUE_KEYS = [
  QUEUE_NAMES.INGESTION,
  QUEUE_NAMES.PATCH,
  QUEUE_NAMES.EXTRACTION,
  QUEUE_NAMES.PUBLISH,
  QUEUE_NAMES.SEARCH,
] as const;
export type QueueKey = (typeof QUEUE_KEYS)[number];

export const JOB_NAMES = {
  ROUTE_CLASSIFIER: "route-classifier",
  PATCH_GENERATOR: "patch-generator",
  TRIPLE_EXTRACTOR: "triple-extractor",
  PUBLISH_RENDERER: "publish-renderer",
  SEARCH_INDEX_UPDATER: "search-index-updater",
} as const;

export const ERROR_CODES = {
  EMAIL_CONFLICT: "EMAIL_CONFLICT",
  INVALID_CREDENTIALS: "INVALID_CREDENTIALS",
  USER_NOT_FOUND: "USER_NOT_FOUND",
  NOT_FOUND: "NOT_FOUND",
  EMPTY_UPDATE: "EMPTY_UPDATE",
  SLUG_CONFLICT: "SLUG_CONFLICT",
  FOLDER_NOT_FOUND: "FOLDER_NOT_FOUND",
  PAGE_NOT_FOUND: "PAGE_NOT_FOUND",
  PAGE_PARENT_NOT_FOUND: "PAGE_PARENT_NOT_FOUND",
  PAGE_PARENT_INVALID: "PAGE_PARENT_INVALID",
  PAGE_PARENT_CYCLE: "PAGE_PARENT_CYCLE",
  REVISION_NOT_FOUND: "REVISION_NOT_FOUND",
  DIFF_NOT_FOUND: "DIFF_NOT_FOUND",
  NO_REVISION: "NO_REVISION",
  PUBLISH_CONFLICT: "PUBLISH_CONFLICT",
  DOC_NOT_FOUND: "DOC_NOT_FOUND",
  WORKSPACE_NOT_FOUND: "WORKSPACE_NOT_FOUND",
  NO_API_TOKEN: "NO_API_TOKEN",
  MISSING_TARGET_PAGE: "MISSING_TARGET_PAGE",
  RATE_LIMIT_EXCEEDED: "RATE_LIMIT_EXCEEDED",
  INGESTION_QUOTA_EXCEEDED: "INGESTION_QUOTA_EXCEEDED",
  IMPORT_FILE_MISSING: "IMPORT_FILE_MISSING",
  IMPORT_FILE_UNSUPPORTED: "IMPORT_FILE_UNSUPPORTED",
  IMPORT_FILE_TOO_LARGE: "IMPORT_FILE_TOO_LARGE",
  IMPORT_EXTRACTION_FAILED: "IMPORT_EXTRACTION_FAILED",
  IMPORT_URL_UNSAFE: "IMPORT_URL_UNSAFE",
  IMPORT_URL_FETCH_FAILED: "IMPORT_URL_FETCH_FAILED",
  IMPORT_MODE_DISABLED: "IMPORT_MODE_DISABLED",
  IMPORT_STORAGE_UNAVAILABLE: "IMPORT_STORAGE_UNAVAILABLE",
  INGESTION_ORIGINAL_NOT_FOUND: "INGESTION_ORIGINAL_NOT_FOUND",
  PAGE_NOT_TRASHED: "PAGE_NOT_TRASHED",
  PUBLISHED_BLOCK: "PUBLISHED_BLOCK",
} as const;
