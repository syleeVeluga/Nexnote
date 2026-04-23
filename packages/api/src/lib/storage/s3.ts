import { Readable } from "node:stream";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectsCommand,
  NoSuchKey,
  NotFound,
} from "@aws-sdk/client-s3";

// Single place to decide whether S3 is configured. Missing config = module runs
// in no-op mode so dev machines without MinIO can still boot the API. The
// callers treat a null storageKey as "no original archived" and the UI simply
// hides the download button — matches the plan's degrade-not-break posture.
const ENDPOINT = process.env["S3_ENDPOINT"];
const REGION = process.env["S3_REGION"] ?? "us-east-1";
const BUCKET = process.env["S3_BUCKET"] ?? "wekiflow-ingestions";
const ACCESS_KEY = process.env["S3_ACCESS_KEY"];
const SECRET_KEY = process.env["S3_SECRET_KEY"];
const FORCE_PATH_STYLE =
  (process.env["S3_FORCE_PATH_STYLE"] ?? "true").toLowerCase() !== "false";

export const storageEnabled = Boolean(ENDPOINT && ACCESS_KEY && SECRET_KEY);

let cached: S3Client | null = null;
function client(): S3Client {
  if (!cached) {
    if (!storageEnabled) {
      throw new Error(
        "Storage client accessed while S3 is not configured. Callers should check storageEnabled first.",
      );
    }
    cached = new S3Client({
      endpoint: ENDPOINT,
      region: REGION,
      credentials: { accessKeyId: ACCESS_KEY!, secretAccessKey: SECRET_KEY! },
      forcePathStyle: FORCE_PATH_STYLE,
    });
  }
  return cached;
}

export function bucketName(): string {
  return BUCKET;
}

function monthPrefix(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

// Deterministic key scheme: workspace prefix lets us scope lifecycle/IAM, the
// month prefix keeps listings from getting huge, sha256 makes the same file
// idempotent under replays (PutObject overwrite is a no-op).
export function buildKey(
  workspaceId: string,
  sha256Hex: string,
  extension?: string | null,
): string {
  const ext = normalizeExtension(extension);
  return `ws/${workspaceId}/${monthPrefix()}/${sha256Hex}${ext}`;
}

function normalizeExtension(extension?: string | null): string {
  if (!extension) return "";
  const trimmed = extension.trim().toLowerCase();
  if (!trimmed) return "";
  const withDot = trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
  return /^\.[a-z0-9]{1,8}$/.test(withDot) ? withDot : "";
}

export async function putOriginal(
  key: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  await client().send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
      ContentLength: body.byteLength,
    }),
  );
}

export class OriginalNotFoundError extends Error {
  constructor(key: string) {
    super(`Original blob not found for key ${key}`);
  }
}

export async function getOriginalStream(key: string): Promise<{
  stream: Readable;
  contentType: string;
  contentLength: number | null;
}> {
  try {
    const res = await client().send(
      new GetObjectCommand({ Bucket: BUCKET, Key: key }),
    );
    if (!res.Body) throw new OriginalNotFoundError(key);
    return {
      stream: res.Body as Readable,
      contentType: res.ContentType ?? "application/octet-stream",
      contentLength: res.ContentLength ?? null,
    };
  } catch (err) {
    if (err instanceof NoSuchKey || err instanceof NotFound) {
      throw new OriginalNotFoundError(key);
    }
    throw err;
  }
}

export async function deleteOriginals(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  // DeleteObjects caps at 1000 keys per request; batch defensively.
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    await client().send(
      new DeleteObjectsCommand({
        Bucket: BUCKET,
        Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
      }),
    );
  }
}
