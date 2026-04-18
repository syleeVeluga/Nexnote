import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { extractWebPage, WebExtractError } from "./web.js";

interface FakeResponseInit {
  status?: number;
  contentType?: string;
  contentLength?: string | null;
  body?: string | Uint8Array | null;
  /** When set, the body stream emits chunks totaling this many bytes. */
  streamBytes?: number;
  url?: string;
}

function makeStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(chunks[i++]);
      } else {
        controller.close();
      }
    },
  });
}

function fakeResponse(init: FakeResponseInit): Response {
  const {
    status = 200,
    contentType = "text/html; charset=utf-8",
    contentLength,
    body,
    streamBytes,
    url = "https://example.com/",
  } = init;

  const headers = new Headers();
  if (contentType) headers.set("content-type", contentType);
  if (contentLength !== null && contentLength !== undefined) {
    headers.set("content-length", contentLength);
  }

  let bodyStream: ReadableStream<Uint8Array> | null = null;
  if (streamBytes !== undefined) {
    const chunk = new Uint8Array(64 * 1024); // 64 KiB of zeros
    const chunks: Uint8Array[] = [];
    let remaining = streamBytes;
    while (remaining > 0) {
      const size = Math.min(chunk.length, remaining);
      chunks.push(chunk.subarray(0, size));
      remaining -= size;
    }
    bodyStream = makeStream(chunks);
  } else if (body != null) {
    const bytes =
      typeof body === "string" ? new TextEncoder().encode(body) : body;
    bodyStream = makeStream([bytes]);
  } else {
    bodyStream = makeStream([]);
  }

  const res = new Response(bodyStream, { status, headers });
  // Override response.url so `finalUrl` is deterministic for tests
  Object.defineProperty(res, "url", { value: url });
  return res;
}

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("extractWebPage — SSRF guard", () => {
  it("rejects unsafe URL before fetching", async () => {
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return fakeResponse({ body: "" });
    };

    await assert.rejects(
      () => extractWebPage("http://127.0.0.1/"),
      (err: unknown) => {
        assert.ok(err instanceof WebExtractError);
        assert.equal((err as WebExtractError).code, "unsafe-url");
        return true;
      },
    );
    assert.equal(fetchCalled, false);
  });

  it("rejects file:// scheme", async () => {
    await assert.rejects(
      () => extractWebPage("file:///etc/passwd"),
      (err: unknown) =>
        err instanceof WebExtractError && (err as WebExtractError).code === "unsafe-url",
    );
  });
});

describe("extractWebPage — fetch error paths", () => {
  it("wraps network errors as fetch-failed", async () => {
    globalThis.fetch = async () => {
      throw new TypeError("network down");
    };
    await assert.rejects(
      () => extractWebPage("https://8.8.8.8/"),
      (err: unknown) => {
        assert.ok(err instanceof WebExtractError);
        assert.equal((err as WebExtractError).code, "fetch-failed");
        return true;
      },
    );
  });

  it("rejects non-2xx responses as fetch-non-2xx", async () => {
    globalThis.fetch = async () =>
      fakeResponse({ status: 404, body: "not found" });
    await assert.rejects(
      () => extractWebPage("https://8.8.8.8/"),
      (err: unknown) =>
        err instanceof WebExtractError &&
        (err as WebExtractError).code === "fetch-non-2xx",
    );
  });

  it("rejects unsupported content-type (image/png)", async () => {
    globalThis.fetch = async () =>
      fakeResponse({ contentType: "image/png", body: "" });
    await assert.rejects(
      () => extractWebPage("https://8.8.8.8/"),
      (err: unknown) =>
        err instanceof WebExtractError &&
        (err as WebExtractError).code === "unsupported-content-type",
    );
  });

  it("rejects application/json content-type", async () => {
    globalThis.fetch = async () =>
      fakeResponse({
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    await assert.rejects(
      () => extractWebPage("https://8.8.8.8/"),
      (err: unknown) =>
        err instanceof WebExtractError &&
        (err as WebExtractError).code === "unsupported-content-type",
    );
  });
});

describe("extractWebPage — size guards", () => {
  it("rejects when content-length header exceeds limit", async () => {
    const prev = process.env["WEB_IMPORT_MAX_RESPONSE_BYTES"];
    process.env["WEB_IMPORT_MAX_RESPONSE_BYTES"] = "1024";
    try {
      globalThis.fetch = async () =>
        fakeResponse({ contentLength: "10485760", body: "x".repeat(100) });
      // NOTE: the limit is read once at module load, so this env override only
      // catches requests exceeding the MODULE-LOAD value. We still assert we
      // can trigger the too-large path via a huge declared length that beats
      // any reasonable limit.
      globalThis.fetch = async () =>
        fakeResponse({ contentLength: "104857600", body: "x" });
      await assert.rejects(
        () => extractWebPage("https://8.8.8.8/"),
        (err: unknown) =>
          err instanceof WebExtractError &&
          (err as WebExtractError).code === "response-too-large",
      );
    } finally {
      if (prev === undefined) delete process.env["WEB_IMPORT_MAX_RESPONSE_BYTES"];
      else process.env["WEB_IMPORT_MAX_RESPONSE_BYTES"] = prev;
    }
  });

  it("rejects when streamed body exceeds limit even without content-length", async () => {
    // Default limit is 10 MiB; emit 11 MiB in chunks.
    globalThis.fetch = async () =>
      fakeResponse({
        contentLength: null,
        streamBytes: 11 * 1024 * 1024,
      });
    await assert.rejects(
      () => extractWebPage("https://8.8.8.8/"),
      (err: unknown) =>
        err instanceof WebExtractError &&
        (err as WebExtractError).code === "response-too-large",
    );
  });
});

describe("extractWebPage — successful extractions", () => {
  it("extracts an article from HTML and converts to Markdown", async () => {
    const html = `<!doctype html>
<html><head><title>Hello World</title></head>
<body>
  <article>
    <h1>Hello World</h1>
    <p>This is a paragraph of at least fifty characters so we do not trigger the short-content warning heuristic.</p>
    <p>Another paragraph with <strong>bold</strong> text.</p>
  </article>
</body></html>`;
    globalThis.fetch = async () =>
      fakeResponse({ body: html, url: "https://example.com/hello" });

    const result = await extractWebPage("https://example.com/hello");
    assert.ok(result.content.length > 0);
    assert.ok(result.content.includes("paragraph"));
    // Readability may dedupe the h1 when it matches <title>; assert the
    // title field instead of relying on heading presence in the body.
    assert.equal(result.title, "Hello World");
    // Bold markup should round-trip through turndown as GFM.
    assert.match(result.content, /\*\*bold\*\*/);
    assert.equal(result.finalUrl, "https://example.com/hello");
    assert.equal(result.extractorVersion, "readability@0.5+turndown@7");
    assert.deepEqual(result.warnings, []);
  });

  it("passes through text/plain without running Readability", async () => {
    const plain = "Just some plain text that is at least fifty characters long so it is not flagged short.";
    globalThis.fetch = async () =>
      fakeResponse({
        contentType: "text/plain; charset=utf-8",
        body: plain,
      });
    const r = await extractWebPage("https://8.8.8.8/");
    assert.equal(r.content, plain.trim());
    assert.equal(r.extractorVersion, "raw-text");
    assert.deepEqual(r.warnings, []);
  });

  it("emits short-content warning for tiny plain text", async () => {
    globalThis.fetch = async () =>
      fakeResponse({ contentType: "text/plain", body: "short" });
    const r = await extractWebPage("https://8.8.8.8/");
    assert.deepEqual(r.warnings, ["short-content"]);
  });

  it("throws no-article when Readability finds no content", async () => {
    // Minimal HTML with no substantial content
    const html = "<html><head></head><body></body></html>";
    globalThis.fetch = async () => fakeResponse({ body: html });
    await assert.rejects(
      () => extractWebPage("https://8.8.8.8/"),
      (err: unknown) =>
        err instanceof WebExtractError &&
        (err as WebExtractError).code === "no-article",
    );
  });
});
