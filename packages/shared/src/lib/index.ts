export {
  computeMarkdownDiff,
  computeBlockDiff,
  computeDiff,
  UNIFIED_DIFF_HEADER_LINES,
  type BlockDiffOp,
  type BlockDiffResult,
  type DiffResult,
} from "./diff-engine.js";
export { classifyDecisionStatus } from "./decision-classifier.js";
export { extractIngestionText } from "./ingestion-text.js";
export { normalizeKey } from "./normalize-key.js";
export { slugify } from "./slugify.js";
export {
  estimateTokens,
  sliceWithinTokenBudget,
  allocateBudgets,
  type SliceResult,
  type BudgetSlot,
  type AllocatedSlot,
} from "./token-budget.js";
