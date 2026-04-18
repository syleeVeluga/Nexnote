import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type fastifyMultipart from "@fastify/multipart";
import {
  ERROR_CODES,
  importTextBodySchema,
  importUrlBodySchema,
} from "@nexnote/shared";
import {
  EDITOR_PLUS_ROLES,
  forbidden,
  getMemberRole,
  insufficientRole,
  workspaceParamsSchema,
} from "../../lib/workspace-auth.js";
import {
  sendRateLimitExceeded,
  sendValidationError,
} from "../../lib/reply-helpers.js";
import {
  consumeRateLimit,
  parsePositiveInt,
} from "../../lib/rate-limit.js";
import {
  enqueueIngestion,
  getOrCreateImportTokenId,
} from "../../lib/enqueue-ingestion.js";
import {
  ACCEPTED_UPLOAD_MIMES,
  ExtractError,
  extractUploadedFile,
} from "../../lib/extractors/office.js";
import {
  extractWebPage,
  WebExtractError,
} from "../../lib/extractors/web.js";
import { mapIngestionDto } from "./ingestions.js";

const IMPORT_RATE_PER_MIN = parsePositiveInt(
  process.env["IMPORT_RATE_LIMIT_PER_MINUTE"],
  30,
);
const INGESTION_QUOTA_PER_DAY = parsePositiveInt(
  process.env["INGESTION_QUOTA_PER_DAY"],
  5000,
);
const MAX_UPLOAD_BYTES = parsePositiveInt(
  process.env["INGESTION_MAX_UPLOAD_BYTES"],
  20 * 1024 * 1024,
);

function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

function extensionToMime(filename: string | undefined): string | undefined {
  if (!filename) return undefined;
  const lower = filename.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "text/markdown";
  if (lower.endsWith(".txt")) return "text/plain";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".docx"))
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (lower.endsWith(".pptx"))
    return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  if (lower.endsWith(".xlsx"))
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  return undefined;
}

type MultipartFilePart = fastifyMultipart.MultipartFile;

async function authorizeImport(
  fastify: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<
  | { ok: true; workspaceId: string; userId: string }
  | { ok: false }
> {
  const parsed = workspaceParamsSchema.safeParse(request.params);
  if (!parsed.success) {
    sendValidationError(reply, parsed.error.issues);
    return { ok: false };
  }
  const workspaceId = parsed.data.workspaceId;
  const userId = request.user.sub;
  const role = await getMemberRole(fastify.db, workspaceId, userId);
  if (!role) {
    forbidden(reply);
    return { ok: false };
  }
  if (!EDITOR_PLUS_ROLES.includes(role)) {
    insufficientRole(reply);
    return { ok: false };
  }
  return { ok: true, workspaceId, userId };
}

async function enforceImportRateLimits(
  fastify: FastifyInstance,
  workspaceId: string,
  userId: string,
  reply: FastifyReply,
): Promise<boolean> {
  const userLimit = await consumeRateLimit(fastify.redis, {
    key: `ingest:user:${userId}`,
    limit: IMPORT_RATE_PER_MIN,
    windowSec: 60,
  });
  if (!userLimit.allowed) {
    sendRateLimitExceeded(
      reply,
      userLimit,
      ERROR_CODES.RATE_LIMIT_EXCEEDED,
      `Import limited to ${IMPORT_RATE_PER_MIN} per minute. Retry after ${userLimit.resetSec}s.`,
    );
    return false;
  }

  const workspaceQuota = await consumeRateLimit(fastify.redis, {
    key: `ingest:workspace:${workspaceId}`,
    limit: INGESTION_QUOTA_PER_DAY,
    windowSec: 86400,
  });
  if (!workspaceQuota.allowed) {
    sendRateLimitExceeded(
      reply,
      workspaceQuota,
      ERROR_CODES.INGESTION_QUOTA_EXCEEDED,
      `Workspace exceeded ${INGESTION_QUOTA_PER_DAY} ingestions for today. Resets in ${workspaceQuota.resetSec}s.`,
    );
    return false;
  }
  return true;
}

async function readFileBuffer(part: MultipartFilePart): Promise<Buffer | null> {
  try {
    const chunks: Buffer[] = [];
    let received = 0;
    for await (const chunk of part.file) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += buf.byteLength;
      if (received > MAX_UPLOAD_BYTES) {
        return null;
      }
      chunks.push(buf);
    }
    if (part.file.truncated) return null;
    return Buffer.concat(chunks);
  } catch {
    return null;
  }
}

export async function registerImportRoutes(fastify: FastifyInstance) {
  // POST /upload — multipart file upload
  fastify.post(
    "/upload",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const auth = await authorizeImport(fastify, request, reply);
      if (!auth.ok) return;

      if (!request.isMultipart()) {
        return reply.code(400).send({
          error: "Bad request",
          code: ERROR_CODES.IMPORT_FILE_MISSING,
          details: "Expected multipart/form-data",
        });
      }

      // Drain fields + file in a single pass
      let file: MultipartFilePart | null = null;
      let titleHint: string | undefined;
      let explicitIdempotencyKey: string | undefined;

      try {
        for await (const part of request.parts()) {
          if (part.type === "file") {
            if (part.fieldname !== "file") {
              part.file.resume();
              continue;
            }
            file = part;
            break;
          }
          if (part.fieldname === "titleHint" && typeof part.value === "string") {
            titleHint = part.value.slice(0, 500);
          } else if (
            part.fieldname === "idempotencyKey" &&
            typeof part.value === "string"
          ) {
            explicitIdempotencyKey = part.value.slice(0, 200);
          }
        }
      } catch (err) {
        fastify.log.error({ err }, "multipart parse failed");
        return reply.code(400).send({
          error: "Bad request",
          code: ERROR_CODES.IMPORT_FILE_MISSING,
          details: "Could not parse multipart body",
        });
      }

      if (!file) {
        return reply.code(400).send({
          error: "Bad request",
          code: ERROR_CODES.IMPORT_FILE_MISSING,
          details: "No file field in request",
        });
      }

      const declaredMime = file.mimetype || "";
      const inferredMime = extensionToMime(file.filename);
      const mime =
        ACCEPTED_UPLOAD_MIMES.has(declaredMime)
          ? declaredMime
          : inferredMime && ACCEPTED_UPLOAD_MIMES.has(inferredMime)
            ? inferredMime
            : declaredMime;

      if (!ACCEPTED_UPLOAD_MIMES.has(mime)) {
        return reply.code(400).send({
          error: "Unsupported file type",
          code: ERROR_CODES.IMPORT_FILE_UNSUPPORTED,
          details: `MIME ${declaredMime || "(unknown)"} is not accepted. Allowed: PDF, DOCX, PPTX, XLSX, MD, TXT.`,
        });
      }

      const buffer = await readFileBuffer(file);
      if (!buffer) {
        return reply.code(413).send({
          error: "File too large",
          code: ERROR_CODES.IMPORT_FILE_TOO_LARGE,
          details: `Exceeded ${MAX_UPLOAD_BYTES} bytes`,
        });
      }

      if (!(await enforceImportRateLimits(fastify, auth.workspaceId, auth.userId, reply))) {
        return;
      }

      let extraction;
      try {
        extraction = await extractUploadedFile(buffer, mime);
      } catch (err) {
        if (err instanceof ExtractError) {
          return reply.code(400).send({
            error: "Extraction failed",
            code: ERROR_CODES.IMPORT_EXTRACTION_FAILED,
            details: `${err.code}: ${err.message}`,
          });
        }
        throw err;
      }

      const apiTokenId = await getOrCreateImportTokenId(
        fastify,
        auth.workspaceId,
        auth.userId,
      );

      const idempotencyKey =
        explicitIdempotencyKey ?? `upload:${sha256(buffer)}:${auth.workspaceId}`;

      const { ingestion, replayed } = await enqueueIngestion(fastify, {
        workspaceId: auth.workspaceId,
        userId: auth.userId,
        apiTokenId,
        sourceName: "manual-upload",
        externalRef: file.filename ?? null,
        idempotencyKey,
        contentType: mime,
        titleHint: titleHint ?? file.filename ?? null,
        rawPayload: {
          content: extraction.content,
          originalFilename: file.filename ?? null,
          originalMimeType: mime,
          originalSizeBytes: buffer.byteLength,
          extractorVersion: extraction.extractorVersion,
          extractionWarnings: extraction.warnings,
        },
      });

      return reply.code(replayed ? 200 : 202).send(mapIngestionDto(ingestion));
    },
  );

  // POST /url — fetch + scrape a single URL
  fastify.post(
    "/url",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const auth = await authorizeImport(fastify, request, reply);
      if (!auth.ok) return;

      const body = importUrlBodySchema.safeParse(request.body);
      if (!body.success) return sendValidationError(reply, body.error.issues);

      if (body.data.mode === "firecrawl" && !process.env["FIRECRAWL_URL"]) {
        return reply.code(400).send({
          error: "firecrawl disabled",
          code: ERROR_CODES.IMPORT_MODE_DISABLED,
          details: "Set FIRECRAWL_URL to enable firecrawl mode",
        });
      }

      if (!(await enforceImportRateLimits(fastify, auth.workspaceId, auth.userId, reply))) {
        return;
      }

      let extraction;
      try {
        // MVP: mode=readable only. firecrawl path reserved for a future sidecar.
        extraction = await extractWebPage(body.data.url);
      } catch (err) {
        if (err instanceof WebExtractError) {
          const isSafety = err.code === "unsafe-url";
          return reply.code(400).send({
            error: isSafety ? "URL not allowed" : "URL extraction failed",
            code: isSafety
              ? ERROR_CODES.IMPORT_URL_UNSAFE
              : ERROR_CODES.IMPORT_URL_FETCH_FAILED,
            details: `${err.code}: ${err.message}`,
          });
        }
        throw err;
      }

      const apiTokenId = await getOrCreateImportTokenId(
        fastify,
        auth.workspaceId,
        auth.userId,
      );

      const forcePart = body.data.forceRefresh
        ? `:force:${Date.now()}`
        : "";
      const idempotencyKey =
        body.data.idempotencyKey ??
        `url:${sha256(`${auth.workspaceId}|${body.data.url}`)}${forcePart}`;

      const { ingestion, replayed } = await enqueueIngestion(fastify, {
        workspaceId: auth.workspaceId,
        userId: auth.userId,
        apiTokenId,
        sourceName: "web-url",
        externalRef: body.data.url,
        idempotencyKey,
        contentType: "text/markdown",
        titleHint: body.data.titleHint ?? extraction.title ?? body.data.url,
        rawPayload: {
          content: extraction.content,
          sourceUrl: body.data.url,
          finalUrl: extraction.finalUrl,
          originalContentType: extraction.contentType,
          extractorVersion: extraction.extractorVersion,
          extractionWarnings: extraction.warnings,
          extractedTitle: extraction.title ?? null,
        },
      });

      return reply.code(replayed ? 200 : 202).send(mapIngestionDto(ingestion));
    },
  );

  // POST /text — paste raw Markdown/plain text
  fastify.post(
    "/text",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const auth = await authorizeImport(fastify, request, reply);
      if (!auth.ok) return;

      const body = importTextBodySchema.safeParse(request.body);
      if (!body.success) return sendValidationError(reply, body.error.issues);

      if (!(await enforceImportRateLimits(fastify, auth.workspaceId, auth.userId, reply))) {
        return;
      }

      const apiTokenId = await getOrCreateImportTokenId(
        fastify,
        auth.workspaceId,
        auth.userId,
      );

      const idempotencyKey =
        body.data.idempotencyKey ??
        `text:${sha256(`${auth.workspaceId}|${body.data.content}`)}`;

      const { ingestion, replayed } = await enqueueIngestion(fastify, {
        workspaceId: auth.workspaceId,
        userId: auth.userId,
        apiTokenId,
        sourceName: body.data.sourceName,
        idempotencyKey,
        contentType: body.data.contentType,
        titleHint: body.data.titleHint,
        rawPayload: {
          content: body.data.content,
          extractorVersion: "raw-text",
        },
      });

      return reply.code(replayed ? 200 : 202).send(mapIngestionDto(ingestion));
    },
  );
}
