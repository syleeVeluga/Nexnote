import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { extractUploadedFile, ExtractError } from "./office.js";

describe("extractUploadedFile — text mimes", () => {
  it("passes through text/markdown trimmed", async () => {
    const buf = Buffer.from("  # Title\n\nbody paragraph.  \n", "utf8");
    const r = await extractUploadedFile(buf, "text/markdown");
    assert.equal(r.content, "# Title\n\nbody paragraph.");
    assert.deepEqual(r.warnings, []);
    assert.equal(r.extractorVersion, "raw-text");
  });

  it("passes through text/plain", async () => {
    const buf = Buffer.from("just some plain text", "utf8");
    const r = await extractUploadedFile(buf, "text/plain");
    assert.equal(r.content, "just some plain text");
    assert.deepEqual(r.warnings, []);
  });

  it("passes through text/x-markdown", async () => {
    const buf = Buffer.from("# heading", "utf8");
    const r = await extractUploadedFile(buf, "text/x-markdown");
    assert.equal(r.content, "# heading");
  });

  it("emits empty-file warning for blank markdown", async () => {
    const buf = Buffer.from("   \n\t\n  ", "utf8");
    const r = await extractUploadedFile(buf, "text/markdown");
    assert.equal(r.content, "");
    assert.deepEqual(r.warnings, ["empty-file"]);
  });

  it("emits empty-file warning for zero-length buffer", async () => {
    const r = await extractUploadedFile(Buffer.alloc(0), "text/plain");
    assert.equal(r.content, "");
    assert.deepEqual(r.warnings, ["empty-file"]);
  });
});

describe("extractUploadedFile — unsupported types", () => {
  it("throws ExtractError with unsupported-mime-type code", async () => {
    await assert.rejects(
      () =>
        extractUploadedFile(Buffer.from("x"), "image/png"),
      (err: unknown) => {
        assert.ok(err instanceof ExtractError);
        assert.ok((err as ExtractError).code.startsWith("unsupported-mime-type:"));
        return true;
      },
    );
  });

  it("rejects application/octet-stream", async () => {
    await assert.rejects(
      () =>
        extractUploadedFile(Buffer.from("x"), "application/octet-stream"),
      (err: unknown) => err instanceof ExtractError,
    );
  });
});

describe("extractUploadedFile — office parse error wrapping", () => {
  it("wraps officeparser failure as ExtractError with office-parse-failed", async () => {
    // Garbage bytes that cannot possibly be a valid PDF/zip.
    const garbage = Buffer.from("not-a-real-pdf-or-zip-file", "utf8");
    await assert.rejects(
      () => extractUploadedFile(garbage, "application/pdf"),
      (err: unknown) => {
        assert.ok(err instanceof ExtractError);
        assert.equal((err as ExtractError).code, "office-parse-failed");
        return true;
      },
    );
  });

  it("wraps docx failure as office-parse-failed for garbage input", async () => {
    const garbage = Buffer.from("PK-but-not-really", "utf8");
    await assert.rejects(
      () =>
        extractUploadedFile(
          garbage,
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ),
      (err: unknown) => {
        assert.ok(err instanceof ExtractError);
        assert.equal((err as ExtractError).code, "office-parse-failed");
        return true;
      },
    );
  });
});
