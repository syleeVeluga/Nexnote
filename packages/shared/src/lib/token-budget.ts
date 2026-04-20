/**
 * Token-budgeting helpers for assembling AI prompts against a model's
 * input-context window without hardcoded `slice(0, N)` cutoffs.
 *
 * The estimator is intentionally conservative — it over-counts CJK and
 * under-counts pure ASCII slightly — so callers pair it with
 * `MODEL_CONTEXT_BUDGETS.safetyMarginRatio` to absorb drift.
 */

export interface SliceResult {
  text: string;
  truncated: boolean;
  droppedChars: number;
  estimatedTokens: number;
}

export interface BudgetSlot {
  key: string;
  text: string;
  /** Floor allocation; never drop below this many tokens for this slot. */
  minTokens: number;
  /** Relative share of the remaining budget after min allocations. */
  weight: number;
}

export interface AllocatedSlot extends SliceResult {
  key: string;
  allocatedTokens: number;
}

// Conservative per-glyph rates tuned so the CJK path over-counts slightly
// versus real BPE tokenizers. Paired with MODEL_CONTEXT_BUDGETS.safetyMarginRatio.
const CJK_CHARS_PER_TOKEN = 1.5;
const OTHER_CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const isCjk =
      (code >= 0x3000 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xff00 && code <= 0xffef);
    if (isCjk) cjk++;
    else other++;
  }
  return Math.ceil(cjk / CJK_CHARS_PER_TOKEN + other / OTHER_CHARS_PER_TOKEN);
}

function tokenBudgetToCharBudget(
  totalChars: number,
  estimatedTokens: number,
  tokenBudget: number,
): number {
  if (tokenBudget <= 0 || totalChars === 0) return 0;
  if (estimatedTokens <= tokenBudget) return totalChars;
  return Math.max(0, Math.floor((totalChars * tokenBudget) / estimatedTokens));
}

/**
 * Slice `text` down to `tokenBudget`. When `preserveStructure` is true, cut
 * at paragraph / sentence boundaries before falling back to a raw trim.
 */
export function sliceWithinTokenBudget(
  text: string,
  tokenBudget: number,
  opts: { preserveStructure?: boolean; estimatedTokens?: number } = {},
): SliceResult {
  if (!text || tokenBudget <= 0) {
    return {
      text: "",
      truncated: text.length > 0,
      droppedChars: text.length,
      estimatedTokens: 0,
    };
  }

  const estimated = opts.estimatedTokens ?? estimateTokens(text);
  if (estimated <= tokenBudget) {
    return { text, truncated: false, droppedChars: 0, estimatedTokens: estimated };
  }

  const charBudget = tokenBudgetToCharBudget(text.length, estimated, tokenBudget);

  if (opts.preserveStructure) {
    const blocks = text.split(/\n\n+/);
    let acc = "";
    for (const block of blocks) {
      const next = acc ? acc + "\n\n" + block : block;
      if (next.length > charBudget) break;
      acc = next;
    }
    if (acc.length > 0) {
      return {
        text: acc,
        truncated: true,
        droppedChars: text.length - acc.length,
        estimatedTokens: estimateTokens(acc),
      };
    }
    const sentences = text.split(/(?<=[.!?。！？])\s+/);
    let sAcc = "";
    for (const s of sentences) {
      const next = sAcc ? sAcc + " " + s : s;
      if (next.length > charBudget) break;
      sAcc = next;
    }
    if (sAcc.length > 0) {
      return {
        text: sAcc,
        truncated: true,
        droppedChars: text.length - sAcc.length,
        estimatedTokens: estimateTokens(sAcc),
      };
    }
  }

  const sliced = text.slice(0, charBudget);
  return {
    text: sliced,
    truncated: true,
    droppedChars: text.length - sliced.length,
    estimatedTokens: estimateTokens(sliced),
  };
}

/**
 * Allocate a shared token budget across named slots. Each slot is
 * guaranteed its `minTokens` floor (clamped if the total budget is smaller
 * than sum of floors); the remainder is split by `weight`. Short slots
 * return unused budget to the pool so hungry slots absorb the slack.
 */
export function allocateBudgets(
  slots: BudgetSlot[],
  totalBudget: number,
  opts: { preserveStructure?: boolean } = {},
): Record<string, AllocatedSlot> {
  if (slots.length === 0) return {};

  // Estimate each slot once up front; reuse this figure through all passes
  // and when invoking sliceWithinTokenBudget below.
  const needs = slots.map((s) => estimateTokens(s.text));
  const out: Record<string, AllocatedSlot> = {};

  const floorSum = slots.reduce((s, x) => s + x.minTokens, 0);

  if (floorSum >= totalBudget) {
    const scale = totalBudget / Math.max(1, floorSum);
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      const allocated = Math.max(0, Math.floor(slot.minTokens * scale));
      const result = sliceWithinTokenBudget(slot.text, allocated, {
        preserveStructure: opts.preserveStructure,
        estimatedTokens: needs[i],
      });
      out[slot.key] = { ...result, key: slot.key, allocatedTokens: allocated };
    }
    return out;
  }

  const remainder = totalBudget - floorSum;
  const weightSum = slots.reduce((s, x) => s + Math.max(0, x.weight), 0) || 1;

  const desired = slots.map((slot, i) => {
    const share = Math.floor((remainder * Math.max(0, slot.weight)) / weightSum);
    return { slot, alloc: slot.minTokens + share, need: needs[i], index: i };
  });

  let slack = 0;
  for (const d of desired) {
    if (d.need < d.alloc) {
      slack += d.alloc - d.need;
      d.alloc = d.need;
    }
  }
  if (slack > 0) {
    const needy = desired.filter((d) => d.need > d.alloc);
    const needyWeightSum =
      needy.reduce((s, x) => s + Math.max(0, x.slot.weight), 0) || 1;
    for (const d of needy) {
      const extra = Math.floor((slack * Math.max(0, d.slot.weight)) / needyWeightSum);
      d.alloc += extra;
    }
  }

  for (const d of desired) {
    const result = sliceWithinTokenBudget(d.slot.text, d.alloc, {
      preserveStructure: opts.preserveStructure,
      estimatedTokens: d.need,
    });
    out[d.slot.key] = { ...result, key: d.slot.key, allocatedTokens: d.alloc };
  }

  return out;
}
