import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import type { DeterministicFacts, TripleExtraction } from "@wekiflow/shared";
import {
  buildDeterministicSeeds,
  prepareTriplesForInsert,
} from "./triple-extractor.js";

type ExtractedTriple = TripleExtraction["triples"][number];

function extractedTriple(
  overrides: Partial<ExtractedTriple>,
): ExtractedTriple {
  return {
    subject: "Acme Corp",
    predicate: "is_a",
    object: "Company",
    objectType: "entity",
    confidence: 0.7,
    spans: [
      {
        start: 0,
        end: 10,
        excerpt: "Acme Corp",
      },
    ],
    ...overrides,
  };
}

function createEntityIdMap() {
  return new Map<string, string>([
    ["acme_corp", "entity-subject"],
    ["company", "entity-object-1"],
    ["organization", "entity-object-2"],
  ]);
}

describe("prepareTriplesForInsert", () => {
  it("dedupes identical logical triples and merges spans with max confidence", () => {
    const entityIdMap = createEntityIdMap();
    const result = prepareTriplesForInsert({
      extractedTriples: [
        extractedTriple({
          confidence: 0.4,
          spans: [
            { start: 0, end: 10, excerpt: "Acme Corp" },
            { start: 20, end: 29, excerpt: "company" },
          ],
        }),
        extractedTriple({
          confidence: 0.9,
          spans: [
            { start: 20, end: 29, excerpt: "company" },
            { start: 40, end: 47, excerpt: "Company" },
          ],
        }),
      ],
      entityIdMap,
      workspaceId: "ws1",
      pageId: "page1",
      revisionId: "rev1",
      modelRunId: "run1",
    });

    assert.equal(result.length, 1);
    assert.equal(result[0].confidence, 0.9);
    assert.deepEqual(result[0].spans, [
      { start: 0, end: 10, excerpt: "Acme Corp" },
      { start: 20, end: 29, excerpt: "company" },
      { start: 40, end: 47, excerpt: "Company" },
    ]);
  });

  it("keeps triples distinct when object identity differs", () => {
    const entityIdMap = createEntityIdMap();
    const result = prepareTriplesForInsert({
      extractedTriples: [
        extractedTriple({ object: "Company" }),
        extractedTriple({ object: "Organization" }),
      ],
      entityIdMap,
      workspaceId: "ws1",
      pageId: "page1",
      revisionId: "rev1",
      modelRunId: "run1",
    });

    assert.equal(result.length, 2);
    assert.deepEqual(
      result.map((triple) => triple.objectEntityId),
      ["entity-object-1", "entity-object-2"],
    );
  });

  it("filters unresolved entity references but keeps literal objects", () => {
    const entityIdMap = createEntityIdMap();
    const result = prepareTriplesForInsert({
      extractedTriples: [
        extractedTriple({ subject: "Unknown Subject" }),
        extractedTriple({ object: "Unknown Object" }),
        extractedTriple({ objectType: "literal", object: "2010" }),
      ],
      entityIdMap,
      workspaceId: "ws1",
      pageId: "page1",
      revisionId: "rev1",
      modelRunId: "run1",
    });

    assert.equal(result.length, 1);
    assert.equal(result[0].objectEntityId, null);
    assert.equal(result[0].objectLiteral, "2010");
  });
});

describe("buildDeterministicSeeds", () => {
  const emptyFacts: DeterministicFacts = {
    frontmatter: {},
    title: null,
    aliases: [],
    tags: [],
    externalLinks: [],
    wikilinks: [],
    strippedMarkdown: "",
  };

  it("returns one seed per alias, tag, url, and wikilink, anchored to the page title", () => {
    const facts: DeterministicFacts = {
      ...emptyFacts,
      aliases: ["Acme", "Acme Inc"],
      tags: ["company", "korea"],
      externalLinks: [
        { text: "OpenAI", url: "https://openai.com" },
        { text: "Docs", url: "https://docs.openai.com" },
      ],
      wikilinks: [{ target: "Related Page", display: null }],
    };
    const seeds = buildDeterministicSeeds(facts, "Acme Corp");
    const byPredicate = seeds.reduce<Record<string, string[]>>((acc, seed) => {
      (acc[seed.predicate] ??= []).push(seed.objectLiteral);
      return acc;
    }, {});
    assert.deepEqual(byPredicate["has_alias"], ["Acme", "Acme Inc"]);
    assert.deepEqual(byPredicate["has_tag"], ["company", "korea"]);
    assert.deepEqual(byPredicate["mentions_url"], [
      "https://openai.com",
      "https://docs.openai.com",
    ]);
    assert.deepEqual(byPredicate["links_to"], ["Related Page"]);
    for (const seed of seeds) {
      assert.equal(seed.subjectName, "Acme Corp");
    }
  });

  it("returns an empty list when the page has no title", () => {
    const seeds = buildDeterministicSeeds(
      { ...emptyFacts, tags: ["any"] },
      "   ",
    );
    assert.deepEqual(seeds, []);
  });

  it("dedups duplicate predicate+object pairs", () => {
    const seeds = buildDeterministicSeeds(
      {
        ...emptyFacts,
        tags: ["alpha", "alpha", "beta"],
      },
      "Page",
    );
    assert.deepEqual(
      seeds.map((s) => s.objectLiteral),
      ["alpha", "beta"],
    );
  });
});