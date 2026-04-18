import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { groupEvidenceByPage, type RawEvidenceRow } from "./entity-provenance.js";

function row(overrides: Partial<RawEvidenceRow>): RawEvidenceRow {
  return {
    tripleId: "t1",
    pageId: "p1",
    spanStart: 0,
    spanEnd: 10,
    excerpt: "excerpt",
    predicate: "works_at",
    ...overrides,
  };
}

describe("groupEvidenceByPage", () => {
  it("returns an empty map for no rows", () => {
    const result = groupEvidenceByPage([]);
    assert.equal(result.size, 0);
  });

  it("groups contiguous rows by pageId preserving input order", () => {
    const rows: RawEvidenceRow[] = [
      row({ pageId: "p1", tripleId: "t1", spanStart: 0 }),
      row({ pageId: "p1", tripleId: "t2", spanStart: 20 }),
      row({ pageId: "p2", tripleId: "t3", spanStart: 5 }),
    ];
    const result = groupEvidenceByPage(rows);
    assert.equal(result.size, 2);
    const p1 = result.get("p1");
    assert.ok(p1);
    assert.equal(p1.length, 2);
    assert.equal(p1[0].tripleId, "t1");
    assert.equal(p1[1].tripleId, "t2");
    const p2 = result.get("p2");
    assert.ok(p2);
    assert.equal(p2.length, 1);
    assert.equal(p2[0].tripleId, "t3");
  });

  it("coerces string span bounds to numbers", () => {
    const result = groupEvidenceByPage([
      row({ spanStart: "42", spanEnd: "99" }),
    ]);
    const items = result.get("p1");
    assert.ok(items);
    assert.strictEqual(items[0].spanStart, 42);
    assert.strictEqual(items[0].spanEnd, 99);
    assert.equal(typeof items[0].spanStart, "number");
    assert.equal(typeof items[0].spanEnd, "number");
  });

  it("preserves predicate and excerpt verbatim", () => {
    const result = groupEvidenceByPage([
      row({ predicate: "founded_by", excerpt: "Acme was founded by Alice." }),
    ]);
    const items = result.get("p1");
    assert.ok(items);
    assert.equal(items[0].predicate, "founded_by");
    assert.equal(items[0].excerpt, "Acme was founded by Alice.");
  });

  it("merges non-contiguous rows for the same pageId", () => {
    const rows: RawEvidenceRow[] = [
      row({ pageId: "p1", tripleId: "t1" }),
      row({ pageId: "p2", tripleId: "t2" }),
      row({ pageId: "p1", tripleId: "t3" }),
    ];
    const result = groupEvidenceByPage(rows);
    const p1 = result.get("p1");
    assert.ok(p1);
    assert.equal(p1.length, 2);
    assert.deepEqual(
      p1.map((e) => e.tripleId),
      ["t1", "t3"],
    );
  });
});
