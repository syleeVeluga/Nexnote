import { and, eq, inArray } from "drizzle-orm";
import { modelRuns, predicateDisplayLabels } from "@wekiflow/db";
import { getAIAdapter, getDefaultProvider } from "../ai-gateway.js";
import type { AIRequest } from "@wekiflow/shared";
import { MODE_OUTPUT_RESERVE } from "@wekiflow/shared";

const PROMPT_VERSION = "predicate-label-v2";
const PREDICATE_LABEL_BATCH_SIZE = 24;
const CURATED_PREDICATE_LABELS = {
  ko: {
    announced_on: "발표일",
    authors: "작성함",
    born_in: "출생지",
    documents: "기록함",
    founded_by: "설립자",
    founded_in: "설립연도",
    has_amount: "수량",
    has_date: "날짜",
    informs: "알림",
    is_a: "~이다",
    located_in: "위치함",
    part_of: "속함",
    produces: "생성함",
    works_at: "근무함",
  },
  en: {
    announced_on: "announced on",
    authors: "authors",
    born_in: "born in",
    documents: "documents",
    founded_by: "founded by",
    founded_in: "founded in",
    has_amount: "has amount",
    has_date: "has date",
    informs: "informs",
    is_a: "is a",
    located_in: "located in",
    part_of: "part of",
    produces: "produces",
    works_at: "works at",
  },
} as const;

interface PredicateLabelPair {
  predicate: string;
  displayLabel: string;
}

interface PredicateLabelLocaleDescriptor {
  languageName: "Korean" | "English";
  exampleLabel: string;
  extraRules?: string;
}

function getPredicateLabelProvider(): {
  provider: "openai" | "gemini";
  model: string;
} {
  if (process.env["AI_TEST_MODE"] === "mock") {
    return { provider: "openai", model: "mock-e2e" };
  }
  if (process.env["OPENAI_API_KEY"]) {
    return {
      provider: "openai",
      model: process.env["PREDICATE_LABEL_OPENAI_MODEL"] ?? "gpt-5.4-mini",
    };
  }
  if (process.env["GEMINI_API_KEY"]) {
    return {
      provider: "gemini",
      model:
        process.env["PREDICATE_LABEL_GEMINI_MODEL"] ??
        "gemini-3.1-flash-lite",
    };
  }
  return getDefaultProvider();
}

function normalizeDisplayLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ").slice(0, 40);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getLocaleDescriptor(
  locale: "ko" | "en",
): PredicateLabelLocaleDescriptor {
  return locale === "ko"
    ? {
        languageName: "Korean",
        exampleLabel: "\uadfc\ubb34\ud568",
        extraRules: `- For Korean, prefer short relation labels that read naturally on graph edges.
- Use predicate-like wording when it makes the direction clearer, such as "속함", "근무함", or "생성함".
- Avoid stiff noun-only translations like "구성" or "생산" when they obscure the relationship.
- Noun labels are still fine when they are the clearest UI form, such as "설립자", "출생지", or "발표일".`,
      }
    : {
        languageName: "English",
        exampleLabel: "works at",
      };
}

export function getCuratedPredicateLabels(
  locale: "ko" | "en",
  predicates: Iterable<string>,
): PredicateLabelPair[] {
  const curated = CURATED_PREDICATE_LABELS[locale];
  const labels: PredicateLabelPair[] = [];
  const seen = new Set<string>();

  for (const predicate of predicates) {
    const normalizedPredicate = predicate.trim();
    if (!normalizedPredicate || seen.has(normalizedPredicate)) {
      continue;
    }

    const displayLabel = curated[normalizedPredicate as keyof typeof curated];
    if (!displayLabel) {
      continue;
    }

    labels.push({
      predicate: normalizedPredicate,
      displayLabel: normalizeDisplayLabel(displayLabel),
    });
    seen.add(normalizedPredicate);
  }

  return labels;
}

export function buildPromptMessages(
  locale: "ko" | "en",
  predicates: string[],
): AIRequest["messages"] {
  const descriptor = getLocaleDescriptor(locale);

  return [
    {
      role: "system",
      content: `You generate ${descriptor.languageName} display labels for ontology predicates.

Rules:
- Keep the canonical predicate unchanged in storage.
- Return only concise ${descriptor.languageName} UI labels for display.
- Prefer short, repeatable, ontology-friendly labels.
- Do not output full sentences, particles, or commentary.
- Do not invent new predicates.
- If a predicate is ambiguous, choose the most general ${descriptor.languageName} label that stays reusable.
- If a stable, reusable label is obvious, prefer it over a literal but awkward translation.
- Known good examples: "part_of" -> "${locale === "ko" ? "속함" : "part of"}", "produces" -> "${locale === "ko" ? "생성함" : "produces"}".
${descriptor.extraRules ?? ""}
- Output valid JSON only.

Schema:
{
  "labels": [
    { "predicate": "works_at", "displayLabel": "${descriptor.exampleLabel}" }
  ]
}`,
    },
    {
      role: "user",
      content: JSON.stringify({
        locale,
        predicates,
      }),
    },
  ];
}

export function parsePredicateLabelPayload(
  rawContent: string,
  expectedPredicates: Iterable<string>,
): PredicateLabelPair[] {
  const expected = new Set(expectedPredicates);
  const parsed = JSON.parse(rawContent) as unknown;

  if (!isRecord(parsed) || !Array.isArray(parsed["labels"])) {
    throw new Error("Predicate label response must include a labels array");
  }

  const results: PredicateLabelPair[] = [];
  const seen = new Set<string>();

  for (const item of parsed["labels"]) {
    if (!isRecord(item)) continue;
    const predicate =
      typeof item["predicate"] === "string" ? item["predicate"].trim() : "";
    const displayLabel =
      typeof item["displayLabel"] === "string"
        ? normalizeDisplayLabel(item["displayLabel"])
        : "";

    if (
      !predicate ||
      !displayLabel ||
      !expected.has(predicate) ||
      seen.has(predicate)
    ) {
      continue;
    }

    results.push({ predicate, displayLabel });
    seen.add(predicate);
  }

  return results;
}

async function loadExistingPredicateLabels(
  db: any,
  locale: "ko" | "en",
  predicates: string[],
): Promise<Array<{ predicate: string; displayLabel: string }>> {
  try {
    return await db
      .select({
        predicate: predicateDisplayLabels.predicate,
        displayLabel: predicateDisplayLabels.displayLabel,
      })
      .from(predicateDisplayLabels)
      .where(
        and(
          eq(predicateDisplayLabels.locale, locale),
          inArray(predicateDisplayLabels.predicate, predicates),
        ),
      );
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === "42P01") {
      return [];
    }
    throw error;
  }
}

async function insertPredicateLabels(
  db: any,
  modelRunId: string,
  locale: "ko" | "en",
  labels: PredicateLabelPair[],
): Promise<void> {
  try {
    await db
      .insert(predicateDisplayLabels)
      .values(
        labels.map((item) => ({
          predicate: item.predicate,
          locale,
          displayLabel: item.displayLabel,
          source: "ai",
          modelRunId,
        })),
      )
      .onConflictDoNothing();
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === "42P01") {
      return;
    }
    throw error;
  }
}

async function upsertPredicateLabels(
  db: any,
  locale: "ko" | "en",
  labels: PredicateLabelPair[],
): Promise<void> {
  if (labels.length === 0) {
    return;
  }

  try {
    const updatedAt = new Date();
    for (const item of labels) {
      await db
        .insert(predicateDisplayLabels)
        .values({
          predicate: item.predicate,
          locale,
          displayLabel: item.displayLabel,
          source: "curated",
          modelRunId: null,
        })
        .onConflictDoUpdate({
          target: [
            predicateDisplayLabels.locale,
            predicateDisplayLabels.predicate,
          ],
          set: {
            displayLabel: item.displayLabel,
            source: "curated",
            modelRunId: null,
            updatedAt,
          },
        });
    }
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === "42P01") {
      return;
    }
    throw error;
  }
}

export async function ensurePredicateDisplayLabels({
  db,
  workspaceId,
  predicates,
  locale,
  allowAI = true,
}: {
  db: any;
  workspaceId: string;
  predicates: string[];
  locale: "ko" | "en";
  allowAI?: boolean;
}): Promise<void> {
  const uniquePredicates = [
    ...new Set(predicates.map((item) => item.trim()).filter(Boolean)),
  ];
  if (uniquePredicates.length === 0) {
    return;
  }

  const curatedLabels = getCuratedPredicateLabels(locale, uniquePredicates);
  await upsertPredicateLabels(db, locale, curatedLabels);

  if (!allowAI) {
    return;
  }

  const curatedPredicates = new Set(
    curatedLabels.map((item) => item.predicate),
  );
  const predicatesNeedingAI = uniquePredicates.filter(
    (predicate) => !curatedPredicates.has(predicate),
  );
  if (predicatesNeedingAI.length === 0) {
    return;
  }

  const existingRows = await loadExistingPredicateLabels(
    db,
    locale,
    predicatesNeedingAI,
  );
  const existing = new Set(
    existingRows.map(
      (row: { predicate: string; displayLabel: string }) => row.predicate,
    ),
  );
  const missingPredicates = predicatesNeedingAI.filter(
    (predicate) => !existing.has(predicate),
  );

  if (missingPredicates.length === 0) {
    return;
  }

  const { provider, model } = getPredicateLabelProvider();
  const adapter = getAIAdapter(provider);

  for (
    let offset = 0;
    offset < missingPredicates.length;
    offset += PREDICATE_LABEL_BATCH_SIZE
  ) {
    const batch = missingPredicates.slice(
      offset,
      offset + PREDICATE_LABEL_BATCH_SIZE,
    );

    const aiRequest: AIRequest = {
      provider,
      model,
      mode: "predicate_label",
      promptVersion: PROMPT_VERSION,
      messages: buildPromptMessages(locale, batch),
      temperature: 0,
      maxTokens: MODE_OUTPUT_RESERVE.predicate_label,
      responseFormat: "json",
    };

    const aiResponse = await adapter.chat(aiRequest);

    let parsedLabels: PredicateLabelPair[] = [];
    let parseFailed = false;
    try {
      parsedLabels = parsePredicateLabelPayload(aiResponse.content, batch);
    } catch {
      parseFailed = true;
    }

    const [modelRun] = await db
      .insert(modelRuns)
      .values({
        workspaceId,
        provider,
        modelName: model,
        mode: "predicate_label",
        promptVersion: PROMPT_VERSION,
        tokenInput: aiResponse.tokenInput,
        tokenOutput: aiResponse.tokenOutput,
        latencyMs: aiResponse.latencyMs,
        status: parseFailed ? "failed" : "success",
        requestMetaJson: {
          locale,
          predicateCount: batch.length,
          predicates: batch,
        },
        responseMetaJson: parseFailed
          ? { error: "parse_failed", raw: aiResponse.content.slice(0, 500) }
          : { labelCount: parsedLabels.length },
      })
      .returning({ id: modelRuns.id });

    if (parseFailed || parsedLabels.length === 0) {
      continue;
    }

    await insertPredicateLabels(db, modelRun.id, locale, parsedLabels);
  }
}
