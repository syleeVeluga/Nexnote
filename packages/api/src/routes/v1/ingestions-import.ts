import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type fastifyMultipart from "@fastify/multipart";
import {
  ERROR_CODES,
  IMPORT_SOURCE_NAMES,
  importTextBodySchema,
  importUrlBodySchema,
} from "@wekiflow/shared";
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
import { enqueueIngestion } from "../../lib/enqueue-ingestion.js";
import {
  ACCEPTED_UPLOAD_MIMES,
  ExtractError,
  extensionForMime,
  extractUploadedFile,
} from "../../lib/extractors/office.js";
import {
  extractWebPage,
  WebExtractError,
} from "../../lib/extractors/web.js";
import { mapIngestionDto } from "../../lib/ingestion-dto.js";
import {
  buildKey as buildStorageKey,
  putOriginal,
  storageEnabled,
} from "../../lib/storage/s3.js";

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

interface ArchivedBlob {
  storageKey: string;
  storageBytes: number;
  storageSha256: string;
}

async function archiveOriginal(
  fastify: FastifyInstance,
  reply: FastifyReply,
  params: {
    workspaceId: string;
    buffer: Buffer;
    sha256Hex: string;
    mime: string;
    sourceLabel: string;
  },
): Promise<ArchivedBlob | null | "error"> {
  if (!storageEnabled) return null;
  const storageKey = buildStorageKey(
    params.workspaceId,
    params.sha256Hex,
    extensionForMime(params.mime),
  );
  try {
    await putOriginal(storageKey, params.buffer, params.mime);
    return {
      storageKey,
      storageBytes: params.buffer.byteLength,
      storageSha256: params.sha256Hex,
    };
  } catch (err) {
    fastify.log.error(
      { err, storageKey },
      `Failed to archive ${params.sourceLabel} original to object storage`,
    );
    reply.code(503).send({
      error: "Storage unavailable",
      code: ERROR_CODES.IMPORT_STORAGE_UNAVAILABLE,
      details: `Failed to archive the ${params.sourceLabel}. Please retry.`,
    });
    return "error";
  }
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
  const [userLimit, workspaceQuota] = await Promise.all([
    consumeRateLimit(fastify.redis, {
      key: `ingest:user:${userId}`,
      limit: IMPORT_RATE_PER_MIN,
      windowSec: 60,
    }),
    consumeRateLimit(fastify.redis, {
      key: `ingest:workspace:${workspaceId}`,
      limit: INGESTION_QUOTA_PER_DAY,
      windowSec: 86400,
    }),
  ]);

  if (!userLimit.allowed) {
    sendRateLimitExceeded(
      reply,
      userLimit,
      ERROR_CODES.RATE_LIMIT_EXCEEDED,
      `Import limited to ${IMPORT_RATE_PER_MIN} per minute. Retry after ${userLimit.resetSec}s.`,
    );
    return false;
  }
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
  const TEXT_BODY_LIMIT = parsePositiveInt(
    process.env["IMPORT_TEXT_BODY_LIMIT_BYTES"],
    2 * 1024 * 1024,
  );

  fastify.post(
    "/upload",
    {
      onRequest: [fastify.authenticate],
      bodyLimit: MAX_UPLOAD_BYTES,
    },
    async (request, reply) => {
      const auth = await authorizeImport(fastify, request, reply);
      if (!auth.ok) return;

      if (!(await enforceImportRateLimits(fastify, auth.workspaceId, auth.userId, reply))) {
        return;
      }

      if (!request.isMultipart()) {
        return reply.code(400).send({
          error: "Bad request",
          code: ERROR_CODES.IMPORT_FILE_MISSING,
          details: "Expected multipart/form-data",
        });
      }

      // Fields may appear before OR after the file part (browsers append in
      // insertion order), so we must not break out of the loop early.
      let fileBuffer: Buffer | null = null;
      let fileTruncated = false;
      let fileFilename: string | null = null;
      let fileDeclaredMime = "";
      let titleHint: string | undefined;
      let explicitIdempotencyKey: string | undefined;
      let forceRefresh = false;

      try {
        for await (const part of request.parts()) {
          if (part.type === "file") {
            if (part.fieldname !== "file" || fileBuffer !== null) {
              part.file.resume();
              continue;
            }
            fileFilename = part.filename ?? null;
            fileDeclaredMime = part.mimetype || "";
            const buf = await readFileBuffer(part);
            if (!buf) {
              fileTruncated = true;
              continue;
            }
            fileBuffer = buf;
          } else if (
            part.fieldname === "titleHint" &&
            typeof part.value === "string"
          ) {
            titleHint = part.value.slice(0, 500);
          } else if (
            part.fieldname === "idempotencyKey" &&
            typeof part.value === "string"
          ) {
            explicitIdempotencyKey = part.value.slice(0, 200);
          } else if (
            part.fieldname === "forceRefresh" &&
            typeof part.value === "string"
          ) {
            forceRefresh = part.value === "true";
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

      if (fileTruncated) {
        return reply.code(413).send({
          error: "File too large",
          code: ERROR_CODES.IMPORT_FILE_TOO_LARGE,
          details: `Exceeded ${MAX_UPLOAD_BYTES} bytes`,
        });
      }

      if (!fileBuffer) {
        return reply.code(400).send({
          error: "Bad request",
          code: ERROR_CODES.IMPORT_FILE_MISSING,
          details: "No file field in request",
        });
      }

      const inferredMime = extensionToMime(fileFilename ?? undefined);
      const mime =
        ACCEPTED_UPLOAD_MIMES.has(fileDeclaredMime)
          ? fileDeclaredMime
          : inferredMime && ACCEPTED_UPLOAD_MIMES.has(inferredMime)
            ? inferredMime
            : fileDeclaredMime;

      if (!ACCEPTED_UPLOAD_MIMES.has(mime)) {
        return reply.code(400).send({
          error: "Unsupported file type",
          code: ERROR_CODES.IMPORT_FILE_UNSUPPORTED,
          details: `MIME ${fileDeclaredMime || "(unknown)"} is not accepted. Allowed: PDF, DOCX, PPTX, XLSX, MD, TXT.`,
        });
      }

      const buffer = fileBuffer;

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

      const bufferSha256 = sha256(buffer);
      const forcePart = forceRefresh ? `:force:${Date.now()}` : "";
      const idempotencyKey =
        explicitIdempotencyKey ?? `upload:${bufferSha256}:${auth.workspaceId}${forcePart}`;

      const archive = await archiveOriginal(fastify, reply, {
        workspaceId: auth.workspaceId,
        buffer,
        sha256Hex: bufferSha256,
        mime,
        sourceLabel: "uploaded file",
      });
      if (archive === "error") return;

      const { ingestion, replayed } = await enqueueIngestion(fastify, {
        workspaceId: auth.workspaceId,
        userId: auth.userId,
        sourceName: IMPORT_SOURCE_NAMES.MANUAL_UPLOAD,
        externalRef: fileFilename,
        idempotencyKey,
        contentType: mime,
        titleHint: titleHint ?? fileFilename,
        rawPayload: {
          content: extraction.content,
          originalFilename: fileFilename,
          originalMimeType: mime,
          originalSizeBytes: buffer.byteLength,
          extractorVersion: extraction.extractorVersion,
          extractionWarnings: extraction.warnings,
        },
        storageKey: archive?.storageKey ?? null,
        storageBytes: archive?.storageBytes ?? null,
        storageSha256: archive?.storageSha256 ?? null,
      });

      return reply.code(replayed ? 200 : 202).send(mapIngestionDto(ingestion));
    },
  );

  fastify.post(
    "/url",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const auth = await authorizeImport(fastify, request, reply);
      if (!auth.ok) return;

      const body = importUrlBodySchema.safeParse(request.body);
      if (!body.success) return sendValidationError(reply, body.error.issues);

      if (!(await enforceImportRateLimits(fastify, auth.workspaceId, auth.userId, reply))) {
        return;
      }

      // MVP: mode=readable only. firecrawl path reserved for a future sidecar.
      let extraction;
      try {
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

      const forcePart = body.data.forceRefresh
        ? `:force:${Date.now()}`
        : "";
      const idempotencyKey =
        body.data.idempotencyKey ??
        `url:${sha256(`${auth.workspaceId}|${body.data.url}`)}${forcePart}`;

      let archive: ArchivedBlob | null = null;
      if (extraction.rawBody) {
        const rawMime = extraction.contentType.startsWith("text/plain")
          ? "text/plain"
          : "text/html";
        const rawBuffer = Buffer.from(extraction.rawBody, "utf-8");
        const result = await archiveOriginal(fastify, reply, {
          workspaceId: auth.workspaceId,
          buffer: rawBuffer,
          sha256Hex: sha256(rawBuffer),
          mime: rawMime,
          sourceLabel: "fetched page",
        });
        if (result === "error") return;
        archive = result;
      }

      const { ingestion, replayed } = await enqueueIngestion(fastify, {
        workspaceId: auth.workspaceId,
        userId: auth.userId,
        sourceName: IMPORT_SOURCE_NAMES.WEB_URL,
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
        storageKey: archive?.storageKey ?? null,
        storageBytes: archive?.storageBytes ?? null,
        storageSha256: archive?.storageSha256 ?? null,
      });

      return reply.code(replayed ? 200 : 202).send(mapIngestionDto(ingestion));
    },
  );

  fastify.post(
    "/text",
    {
      onRequest: [fastify.authenticate],
      bodyLimit: TEXT_BODY_LIMIT,
    },
    async (request, reply) => {
      const auth = await authorizeImport(fastify, request, reply);
      if (!auth.ok) return;

      const body = importTextBodySchema.safeParse(request.body);
      if (!body.success) return sendValidationError(reply, body.error.issues);

      if (!(await enforceImportRateLimits(fastify, auth.workspaceId, auth.userId, reply))) {
        return;
      }

      const idempotencyKey =
        body.data.idempotencyKey ??
        `text:${sha256(`${auth.workspaceId}|${body.data.content}`)}`;

      const { ingestion, replayed } = await enqueueIngestion(fastify, {
        workspaceId: auth.workspaceId,
        userId: auth.userId,
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
