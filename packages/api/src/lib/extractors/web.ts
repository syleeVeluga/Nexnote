import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
// @ts-expect-error — turndown-plugin-gfm ships without types
import { gfm } from "turndown-plugin-gfm";
import { assertUrlSafe } from "../url-safety.js";
import { parsePositiveInt } from "../rate-limit.js";

export interface WebExtractionResult {
  content: string;
  title?: string;
  warnings: string[];
  extractorVersion: string;
  finalUrl: string;
  contentType: string;
}

export class WebExtractError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "WebExtractError";
  }
}

const FETCH_TIMEOUT_MS = parsePositiveInt(
  process.env["WEB_IMPORT_FETCH_TIMEOUT_MS"],
  15_000,
);
const MAX_RESPONSE_BYTES = parsePositiveInt(
  process.env["WEB_IMPORT_MAX_RESPONSE_BYTES"],
  10 * 1024 * 1024,
);
const USER_AGENT =
  process.env["WEB_IMPORT_USER_AGENT"] ??
  "NexNoteImporter/1.0 (+https://nexnote.app)";

async function fetchHtml(url: string): Promise<{
  html: string;
  finalUrl: string;
  contentType: string;
}> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
      },
    });
  } catch (err) {
    clearTimeout(timeout);
    const message = err instanceof Error ? err.message : String(err);
    throw new WebExtractError("fetch-failed", `Fetch failed: ${message}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new WebExtractError(
      "fetch-non-2xx",
      `Fetch returned HTTP ${response.status}`,
    );
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (
    !contentType.startsWith("text/html") &&
    !contentType.startsWith("application/xhtml+xml") &&
    !contentType.startsWith("text/plain")
  ) {
    throw new WebExtractError(
      "unsupported-content-type",
      `Unsupported content-type: ${contentType || "(empty)"}`,
    );
  }

  const declared = response.headers.get("content-length");
  if (declared) {
    const n = parseInt(declared, 10);
    if (Number.isFinite(n) && n > MAX_RESPONSE_BYTES) {
      throw new WebExtractError(
        "response-too-large",
        `Response ${n} bytes exceeds limit ${MAX_RESPONSE_BYTES}`,
      );
    }
  }

  if (!response.body) {
    throw new WebExtractError("empty-body", "Response had no body");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      received += value.byteLength;
      if (received > MAX_RESPONSE_BYTES) {
        reader.cancel().catch(() => undefined);
        throw new WebExtractError(
          "response-too-large",
          `Stream exceeded limit ${MAX_RESPONSE_BYTES}`,
        );
      }
      chunks.push(value);
    }
  }

  const buffer = Buffer.concat(chunks);
  return {
    html: buffer.toString("utf8"),
    finalUrl: response.url || url,
    contentType,
  };
}

export async function extractWebPage(
  rawUrl: string,
): Promise<WebExtractionResult> {
  const safety = await assertUrlSafe(rawUrl);
  if (!safety.ok) {
    throw new WebExtractError(
      "unsafe-url",
      `URL rejected: ${safety.reason ?? "unknown"}`,
    );
  }

  const { html, finalUrl, contentType } = await fetchHtml(rawUrl);

  if (contentType.startsWith("text/plain")) {
    const trimmed = html.trim();
    return {
      content: trimmed,
      warnings: trimmed.length < 50 ? ["short-content"] : [],
      extractorVersion: "raw-text",
      finalUrl,
      contentType,
    };
  }

  const warnings: string[] = [];
  const dom = new JSDOM(html, { url: finalUrl });

  try {
    const article = new Readability(dom.window.document).parse();
    if (!article || !article.content) {
      throw new WebExtractError(
        "no-article",
        "Readability could not extract a main article",
      );
    }

    const td = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
    });
    td.use(gfm);
    const markdown = td.turndown(article.content).trim();

    if (markdown.length < 50) warnings.push("short-content");

    return {
      content: markdown,
      title: article.title ?? undefined,
      warnings,
      extractorVersion: "readability@0.5+turndown@7",
      finalUrl,
      contentType,
    };
  } finally {
    dom.window.close();
  }
}
