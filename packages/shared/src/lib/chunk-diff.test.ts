import { describe, it, expect } from "vitest";
import {
  buildFocusedInput,
  partitionLeafChunksByHash,
  remapFocusedSpan,
} from "./chunk-diff.js";

describe("partitionLeafChunksByHash", () => {
  it("marks leaves with matching hashes as unchanged and the rest as changed", () => {
    const prev = [
      { id: "p1", contentHash: "a" },
      { id: "p2", contentHash: "b" },
    ];
    const next = [
      { contentHash: "a" },
      { contentHash: "c" },
      { contentHash: "b" },
    ];
    const { unchanged, changed } = partitionLeafChunksByHash(prev, next);
    expect(unchanged.map((u) => u.prev.id)).toEqual(["p1", "p2"]);
    expect(changed.map((c) => c.contentHash)).toEqual(["c"]);
  });

  it("treats empty prev as all changed", () => {
    const next = [{ contentHash: "a" }, { contentHash: "b" }];
    const { unchanged, changed } = partitionLeafChunksByHash([], next);
    expect(unchanged).toEqual([]);
    expect(changed.length).toBe(2);
  });

  it("is empty in both buckets when next is empty", () => {
    const prev = [{ id: "p1", contentHash: "a" }];
    const result = partitionLeafChunksByHash(prev, [] as typeof prev);
    expect(result.unchanged).toEqual([]);
    expect(result.changed).toEqual([]);
  });
});

describe("buildFocusedInput + remapFocusedSpan", () => {
  const chunks = [
    {
      contentMd: "Alpha sentence.",
      charStart: 100,
      charEnd: 115,
      headingPath: ["Intro"],
    },
    {
      contentMd: "Beta sentence.",
      charStart: 500,
      charEnd: 514,
      headingPath: ["Body"],
    },
  ];

  it("concatenates chunks with separators and tracks input/original offsets", () => {
    const { inputText, index } = buildFocusedInput(chunks);
    expect(inputText).toBe("Alpha sentence.\n\nBeta sentence.");
    expect(index).toHaveLength(2);
    expect(index[0]).toMatchObject({
      inputStart: 0,
      inputEnd: 15,
      originalStart: 100,
      originalEnd: 115,
    });
    expect(index[1]).toMatchObject({
      inputStart: 17,
      inputEnd: 31,
      originalStart: 500,
      originalEnd: 514,
    });
  });

  it("remaps a span inside the first chunk", () => {
    const { index } = buildFocusedInput(chunks);
    const remapped = remapFocusedSpan(index, { start: 0, end: 5 });
    expect(remapped).toEqual({ start: 100, end: 105 });
  });

  it("remaps a span inside the second chunk using the chunk's original offset", () => {
    const { index } = buildFocusedInput(chunks);
    const remapped = remapFocusedSpan(index, { start: 17, end: 21 });
    expect(remapped).toEqual({ start: 500, end: 504 });
  });

  it("returns null for spans that straddle a chunk boundary", () => {
    const { index } = buildFocusedInput(chunks);
    expect(remapFocusedSpan(index, { start: 10, end: 20 })).toBeNull();
  });
});
