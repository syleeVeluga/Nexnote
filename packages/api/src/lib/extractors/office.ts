import { parseOfficeAsync } from "officeparser";

export const OFFICE_MIME_TO_KIND = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "docx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    "pptx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.oasis.opendocument.text": "odt",
  "application/vnd.oasis.opendocument.presentation": "odp",
  "application/vnd.oasis.opendocument.spreadsheet": "ods",
} as const;

export const TEXT_MIMES = new Set([
  "text/markdown",
  "text/plain",
  "text/x-markdown",
]);

export const ACCEPTED_UPLOAD_MIMES: ReadonlySet<string> = new Set([
  ...Object.keys(OFFICE_MIME_TO_KIND),
  ...TEXT_MIMES,
]);

const TEXT_MIME_TO_EXT: Record<string, string> = {
  "text/markdown": ".md",
  "text/x-markdown": ".md",
  "text/plain": ".txt",
  "text/html": ".html",
};

export function extensionForMime(mime: string): string | null {
  const officeKind = (
    OFFICE_MIME_TO_KIND as Record<string, string | undefined>
  )[mime];
  if (officeKind) return `.${officeKind}`;
  return TEXT_MIME_TO_EXT[mime] ?? null;
}

export interface FileExtractionResult {
  content: string;
  warnings: string[];
  extractorVersion: string;
}

export async function extractUploadedFile(
  buffer: Buffer,
  mimeType: string,
): Promise<FileExtractionResult> {
  const warnings: string[] = [];

  if (TEXT_MIMES.has(mimeType)) {
    const text = buffer.toString("utf8").trim();
    if (text.length === 0) warnings.push("empty-file");
    return { content: text, warnings, extractorVersion: "raw-text" };
  }

  if (!(mimeType in OFFICE_MIME_TO_KIND)) {
    throw new ExtractError(
      `unsupported-mime-type:${mimeType}`,
      `File type ${mimeType} is not supported`,
    );
  }

  let text: string;
  try {
    text = await parseOfficeAsync(buffer, { outputErrorToConsole: false });
  } catch (err) {
    throw new ExtractError(
      "office-parse-failed",
      err instanceof Error ? err.message : String(err),
    );
  }

  const trimmed = text.trim();
  if (trimmed.length === 0) {
    warnings.push("empty-extraction");
  }

  return {
    content: trimmed,
    warnings,
    extractorVersion: "officeparser@5",
  };
}

export class ExtractError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "ExtractError";
  }
}
