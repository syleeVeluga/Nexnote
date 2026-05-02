const ENDPOINT = process.env["S3_ENDPOINT"];
const REGION = process.env["S3_REGION"] ?? "us-east-1";
const BUCKET = process.env["S3_BUCKET"] ?? "wekiflow-ingestions";
const ACCESS_KEY = process.env["S3_ACCESS_KEY"];
const SECRET_KEY = process.env["S3_SECRET_KEY"];
const FORCE_PATH_STYLE =
  (process.env["S3_FORCE_PATH_STYLE"] ?? "true").toLowerCase() !== "false";

export const storageEnabled = Boolean(ENDPOINT && ACCESS_KEY && SECRET_KEY);

type S3Runtime = {
  client: { send(command: unknown): Promise<unknown> };
  DeleteObjectsCommand: new (input: unknown) => unknown;
};

let cached: S3Runtime | null = null;
async function client(): Promise<S3Runtime> {
  if (!cached) {
    if (!storageEnabled) {
      throw new Error(
        "Storage client accessed while S3 is not configured. Callers should check storageEnabled first.",
      );
    }
    const moduleName = "@aws-sdk/client-s3";
    const { DeleteObjectsCommand, S3Client } = await import(moduleName);
    cached = {
      client: new S3Client({
        endpoint: ENDPOINT,
        region: REGION,
        credentials: { accessKeyId: ACCESS_KEY!, secretAccessKey: SECRET_KEY! },
        forcePathStyle: FORCE_PATH_STYLE,
      }),
      DeleteObjectsCommand,
    };
  }
  return cached;
}

export async function deleteOriginals(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  const s3 = await client();
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    await s3.client.send(
      new s3.DeleteObjectsCommand({
        Bucket: BUCKET,
        Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
      }),
    );
  }
}
