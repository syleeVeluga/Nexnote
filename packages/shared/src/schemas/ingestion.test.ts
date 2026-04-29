import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  routeDecisionSchema,
  tripleExtractionSchema,
  entityTypeEnum,
  createIngestionSchema,
  patchProposalSchema,
} from "./ingestion.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";
const VALID_UUID_2 = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

function expectParseSuccess<T>(schema: { safeParse: (v: unknown) => { success: boolean; data?: T } }, input: unknown): T {
  const result = schema.safeParse(input);
  assert.ok(result.success, `Expected parse to succeed but it failed: ${JSON.stringify(input)}`);
  return result.data as T;
}

function expectParseFailure(schema: { safeParse: (v: unknown) => { success: boolean } }, input: unknown): void {
  const result = schema.safeParse(input);
  assert.equal(result.success, false, `Expected parse to fail but it succeeded: ${JSON.stringify(input)}`);
}

// ---------------------------------------------------------------------------
// routeDecisionSchema
// ---------------------------------------------------------------------------
describe("routeDecisionSchema", () => {
  const validRouteDecision = {
    action: "update",
    targetPageId: VALID_UUID,
    confidence: 0.92,
    reason: "Content closely matches existing page on TypeScript generics",
  };

  it("parses a valid route decision", () => {
    const data = expectParseSuccess(routeDecisionSchema, validRouteDecision);
    assert.equal(data.action, "update");
    assert.equal(data.targetPageId, VALID_UUID);
    assert.equal(data.confidence, 0.92);
    assert.equal(data.reason, "Content closely matches existing page on TypeScript generics");
  });

  it("accepts all valid action values", () => {
    const actions = ["create", "update", "append", "noop", "needs_review"] as const;
    for (const action of actions) {
      const input = { ...validRouteDecision, action };
      expectParseSuccess(routeDecisionSchema, input);
    }
  });

  it("rejects an invalid action value", () => {
    expectParseFailure(routeDecisionSchema, {
      ...validRouteDecision,
      action: "delete",
    });
  });

  it("allows targetPageId to be null", () => {
    const data = expectParseSuccess(routeDecisionSchema, {
      ...validRouteDecision,
      targetPageId: null,
    });
    assert.equal(data.targetPageId, null);
  });

  it("defaults targetPageId to null when omitted", () => {
    const { targetPageId: _drop, ...rest } = validRouteDecision;
    const data = expectParseSuccess(routeDecisionSchema, rest);
    assert.equal(data.targetPageId, null);
  });

  it("rejects targetPageId that is not a UUID", () => {
    expectParseFailure(routeDecisionSchema, {
      ...validRouteDecision,
      targetPageId: "not-a-uuid",
    });
  });

  it("rejects confidence below 0", () => {
    expectParseFailure(routeDecisionSchema, {
      ...validRouteDecision,
      confidence: -0.1,
    });
  });

  it("rejects confidence above 1", () => {
    expectParseFailure(routeDecisionSchema, {
      ...validRouteDecision,
      confidence: 1.01,
    });
  });

  it("accepts confidence at boundary values 0 and 1", () => {
    expectParseSuccess(routeDecisionSchema, { ...validRouteDecision, confidence: 0 });
    expectParseSuccess(routeDecisionSchema, { ...validRouteDecision, confidence: 1 });
  });

  it("accepts proposedTitle as optional", () => {
    const data = expectParseSuccess(routeDecisionSchema, {
      ...validRouteDecision,
      proposedTitle: "New Page Title",
    });
    assert.equal(data.proposedTitle, "New Page Title");
  });

  it("does not require proposedTitle", () => {
    const data = expectParseSuccess(routeDecisionSchema, validRouteDecision);
    assert.equal(data.proposedTitle, undefined);
  });

  it("rejects missing reason field", () => {
    const { reason: _drop, ...rest } = validRouteDecision;
    expectParseFailure(routeDecisionSchema, rest);
  });

  it("rejects missing action field", () => {
    const { action: _drop, ...rest } = validRouteDecision;
    expectParseFailure(routeDecisionSchema, rest);
  });

  it("rejects missing confidence field", () => {
    const { confidence: _drop, ...rest } = validRouteDecision;
    expectParseFailure(routeDecisionSchema, rest);
  });
});

// ---------------------------------------------------------------------------
// tripleExtractionSchema
// ---------------------------------------------------------------------------
describe("tripleExtractionSchema", () => {
  const entityTypes = [
    "person",
    "organization",
    "location",
    "product",
    "document",
    "system",
    "event",
    "concept",
  ] as const;

  const validTriple = {
    subject: "TypeScript",
    predicate: "is_a",
    object: "Programming Language",
    objectType: "entity",
    confidence: 0.95,
    spans: [
      { start: 0, end: 42, excerpt: "TypeScript is a programming language" },
    ],
  };

  const validExtraction = { triples: [validTriple] };

  it("parses a valid triple extraction", () => {
    const data = expectParseSuccess(tripleExtractionSchema, validExtraction);
    assert.equal(data.triples.length, 1);
    assert.equal(data.triples[0].subject, "TypeScript");
    assert.equal(data.triples[0].predicate, "is_a");
    assert.equal(data.triples[0].object, "Programming Language");
  });

  it("accepts optional entity type fields", () => {
    const data = expectParseSuccess(tripleExtractionSchema, {
      triples: [
        {
          ...validTriple,
          subjectType: "product",
          objectEntityType: "concept",
        },
      ],
    });
    assert.equal(data.triples[0].subjectType, "product");
    assert.equal(data.triples[0].objectEntityType, "concept");
  });

  it("keeps entity type fields optional for backwards compatibility", () => {
    const data = expectParseSuccess(tripleExtractionSchema, {
      triples: [validTriple],
    });
    assert.equal(data.triples[0].subjectType, undefined);
    assert.equal(data.triples[0].objectEntityType, undefined);
  });

  it("validates all supported entity types", () => {
    for (const type of entityTypes) {
      expectParseSuccess(entityTypeEnum, type);
      expectParseSuccess(tripleExtractionSchema, {
        triples: [
          {
            ...validTriple,
            subjectType: type,
            objectEntityType: type,
          },
        ],
      });
    }
  });

  it("rejects invalid entity type fields", () => {
    expectParseFailure(tripleExtractionSchema, {
      triples: [{ ...validTriple, subjectType: "team" }],
    });
    expectParseFailure(tripleExtractionSchema, {
      triples: [{ ...validTriple, objectEntityType: "place" }],
    });
  });

  it("accepts empty triples array", () => {
    const data = expectParseSuccess(tripleExtractionSchema, { triples: [] });
    assert.equal(data.triples.length, 0);
  });

  it("accepts multiple triples", () => {
    const data = expectParseSuccess(tripleExtractionSchema, {
      triples: [
        validTriple,
        {
          ...validTriple,
          subject: "React",
          predicate: "uses",
          object: "JavaScript",
        },
      ],
    });
    assert.equal(data.triples.length, 2);
  });

  it("validates objectType enum — entity", () => {
    expectParseSuccess(tripleExtractionSchema, {
      triples: [{ ...validTriple, objectType: "entity" }],
    });
  });

  it("validates objectType enum — literal", () => {
    expectParseSuccess(tripleExtractionSchema, {
      triples: [{ ...validTriple, objectType: "literal" }],
    });
  });

  it("rejects invalid objectType", () => {
    expectParseFailure(tripleExtractionSchema, {
      triples: [{ ...validTriple, objectType: "url" }],
    });
  });

  it("rejects confidence below 0", () => {
    expectParseFailure(tripleExtractionSchema, {
      triples: [{ ...validTriple, confidence: -0.5 }],
    });
  });

  it("rejects confidence above 1", () => {
    expectParseFailure(tripleExtractionSchema, {
      triples: [{ ...validTriple, confidence: 1.5 }],
    });
  });

  it("validates span start and end are integers", () => {
    expectParseFailure(tripleExtractionSchema, {
      triples: [
        {
          ...validTriple,
          spans: [{ start: 0.5, end: 10, excerpt: "text" }],
        },
      ],
    });
    expectParseFailure(tripleExtractionSchema, {
      triples: [
        {
          ...validTriple,
          spans: [{ start: 0, end: 10.7, excerpt: "text" }],
        },
      ],
    });
  });

  it("accepts multiple spans per triple", () => {
    const data = expectParseSuccess(tripleExtractionSchema, {
      triples: [
        {
          ...validTriple,
          spans: [
            { start: 0, end: 10, excerpt: "first" },
            { start: 50, end: 80, excerpt: "second" },
          ],
        },
      ],
    });
    assert.equal(data.triples[0].spans.length, 2);
  });

  it("accepts empty spans array", () => {
    const data = expectParseSuccess(tripleExtractionSchema, {
      triples: [{ ...validTriple, spans: [] }],
    });
    assert.equal(data.triples[0].spans.length, 0);
  });

  it("rejects span missing excerpt", () => {
    expectParseFailure(tripleExtractionSchema, {
      triples: [
        {
          ...validTriple,
          spans: [{ start: 0, end: 10 }],
        },
      ],
    });
  });

  it("rejects missing triples key", () => {
    expectParseFailure(tripleExtractionSchema, {});
  });

  it("rejects missing subject in a triple", () => {
    const { subject: _drop, ...rest } = validTriple;
    expectParseFailure(tripleExtractionSchema, { triples: [rest] });
  });

  it("rejects missing predicate in a triple", () => {
    const { predicate: _drop, ...rest } = validTriple;
    expectParseFailure(tripleExtractionSchema, { triples: [rest] });
  });
});

// ---------------------------------------------------------------------------
// patchProposalSchema
// ---------------------------------------------------------------------------
describe("patchProposalSchema", () => {
  const validPatch = {
    targetPageId: VALID_UUID,
    baseRevisionId: VALID_UUID_2,
    editType: "replace",
    ops: [{ op: "replace", path: "/content", value: "new content" }],
    summary: "Replaced page content with updated information",
  };

  it("parses a valid patch proposal", () => {
    const data = expectParseSuccess(patchProposalSchema, validPatch);
    assert.equal(data.targetPageId, VALID_UUID);
    assert.equal(data.baseRevisionId, VALID_UUID_2);
    assert.equal(data.editType, "replace");
    assert.equal(data.ops.length, 1);
  });

  it("accepts all valid editType values", () => {
    const editTypes = ["replace", "append", "prepend", "patch"] as const;
    for (const editType of editTypes) {
      expectParseSuccess(patchProposalSchema, { ...validPatch, editType });
    }
  });

  it("rejects invalid editType", () => {
    expectParseFailure(patchProposalSchema, { ...validPatch, editType: "delete" });
  });

  it("rejects non-UUID targetPageId", () => {
    expectParseFailure(patchProposalSchema, { ...validPatch, targetPageId: "bad" });
  });

  it("rejects non-UUID baseRevisionId", () => {
    expectParseFailure(patchProposalSchema, { ...validPatch, baseRevisionId: "bad" });
  });

  it("accepts empty ops array", () => {
    const data = expectParseSuccess(patchProposalSchema, { ...validPatch, ops: [] });
    assert.equal(data.ops.length, 0);
  });

  it("rejects missing summary", () => {
    const { summary: _drop, ...rest } = validPatch;
    expectParseFailure(patchProposalSchema, rest);
  });
});

// ---------------------------------------------------------------------------
// createIngestionSchema
// ---------------------------------------------------------------------------
describe("createIngestionSchema", () => {
  const validIngestion = {
    sourceName: "slack-bot",
    idempotencyKey: "msg-12345",
    rawPayload: { content: "Hello, world!", metadata: { channel: "#general" } },
  };

  it("parses a valid create ingestion payload", () => {
    const data = expectParseSuccess(createIngestionSchema, validIngestion);
    assert.equal(data.sourceName, "slack-bot");
    assert.equal(data.idempotencyKey, "msg-12345");
    assert.deepEqual(data.rawPayload, validIngestion.rawPayload);
  });

  it("defaults contentType to text/plain", () => {
    const data = expectParseSuccess(createIngestionSchema, validIngestion);
    assert.equal(data.contentType, "text/plain");
  });

  it("accepts explicit contentType", () => {
    const data = expectParseSuccess(createIngestionSchema, {
      ...validIngestion,
      contentType: "application/json",
    });
    assert.equal(data.contentType, "application/json");
  });

  it("accepts optional externalRef", () => {
    const data = expectParseSuccess(createIngestionSchema, {
      ...validIngestion,
      externalRef: "https://slack.com/archives/C01/p1234",
    });
    assert.equal(data.externalRef, "https://slack.com/archives/C01/p1234");
  });

  it("accepts optional titleHint", () => {
    const data = expectParseSuccess(createIngestionSchema, {
      ...validIngestion,
      titleHint: "Meeting Notes for Q4 Planning",
    });
    assert.equal(data.titleHint, "Meeting Notes for Q4 Planning");
  });

  it("rejects missing sourceName", () => {
    const { sourceName: _drop, ...rest } = validIngestion;
    expectParseFailure(createIngestionSchema, rest);
  });

  it("rejects empty sourceName", () => {
    expectParseFailure(createIngestionSchema, {
      ...validIngestion,
      sourceName: "",
    });
  });

  it("rejects sourceName exceeding 200 chars", () => {
    expectParseFailure(createIngestionSchema, {
      ...validIngestion,
      sourceName: "a".repeat(201),
    });
  });

  it("rejects missing idempotencyKey", () => {
    const { idempotencyKey: _drop, ...rest } = validIngestion;
    expectParseFailure(createIngestionSchema, rest);
  });

  it("rejects empty idempotencyKey", () => {
    expectParseFailure(createIngestionSchema, {
      ...validIngestion,
      idempotencyKey: "",
    });
  });

  it("rejects idempotencyKey exceeding 200 chars", () => {
    expectParseFailure(createIngestionSchema, {
      ...validIngestion,
      idempotencyKey: "k".repeat(201),
    });
  });

  it("rejects missing rawPayload", () => {
    const { rawPayload: _drop, ...rest } = validIngestion;
    expectParseFailure(createIngestionSchema, rest);
  });

  it("rejects non-object rawPayload (string)", () => {
    expectParseFailure(createIngestionSchema, {
      ...validIngestion,
      rawPayload: "just a string",
    });
  });

  it("rejects non-object rawPayload (array)", () => {
    expectParseFailure(createIngestionSchema, {
      ...validIngestion,
      rawPayload: [1, 2, 3],
    });
  });

  it("accepts rawPayload with nested objects", () => {
    const data = expectParseSuccess(createIngestionSchema, {
      ...validIngestion,
      rawPayload: {
        content: "deep",
        nested: { level1: { level2: "value" } },
      },
    });
    assert.ok(data.rawPayload);
  });

  it("rejects contentType exceeding 100 chars", () => {
    expectParseFailure(createIngestionSchema, {
      ...validIngestion,
      contentType: "x".repeat(101),
    });
  });

  it("rejects externalRef exceeding 500 chars", () => {
    expectParseFailure(createIngestionSchema, {
      ...validIngestion,
      externalRef: "r".repeat(501),
    });
  });

  it("rejects titleHint exceeding 500 chars", () => {
    expectParseFailure(createIngestionSchema, {
      ...validIngestion,
      titleHint: "t".repeat(501),
    });
  });
});
