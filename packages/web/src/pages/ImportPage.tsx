import { useCallback, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useWorkspace } from "../hooks/use-workspace.js";
import { ApiError, ingestions as ingestionsApi } from "../lib/api-client.js";

type TabKey = "file" | "url" | "text";

interface FileRowStatus {
  id: string;
  file: File;
  state: "pending" | "uploading" | "queued" | "replayed" | "error";
  message?: string;
  ingestionId?: string;
}

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const SIZE_MB = Math.round(MAX_UPLOAD_BYTES / (1024 * 1024));
const ACCEPT_LIST = [
  ".pdf",
  ".docx",
  ".pptx",
  ".xlsx",
  ".md",
  ".markdown",
  ".txt",
].join(",");

function genId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function mapErrorCode(code: string | undefined, fallback: string): string {
  switch (code) {
    case "IMPORT_FILE_UNSUPPORTED":
      return "errorUnsupported";
    case "IMPORT_FILE_TOO_LARGE":
      return "errorTooLarge";
    case "IMPORT_URL_UNSAFE":
      return "errorUrlUnsafe";
    case "IMPORT_URL_FETCH_FAILED":
    case "IMPORT_EXTRACTION_FAILED":
      return "errorExtraction";
    default:
      return fallback;
  }
}

export function ImportPage() {
  const { t } = useTranslation(["import", "common"]);
  const navigate = useNavigate();
  const { current } = useWorkspace();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [activeTab, setActiveTab] = useState<TabKey>("file");
  const [fileTitleHint, setFileTitleHint] = useState("");
  const [fileRows, setFileRows] = useState<FileRowStatus[]>([]);
  const [isDragging, setIsDragging] = useState(false);

  const [url, setUrl] = useState("");
  const [urlTitleHint, setUrlTitleHint] = useState("");
  const [urlForce, setUrlForce] = useState(false);
  const [urlBusy, setUrlBusy] = useState(false);
  const [urlResult, setUrlResult] = useState<
    { state: "queued" | "replayed" | "error"; message?: string } | null
  >(null);

  const [text, setText] = useState("");
  const [textTitleHint, setTextTitleHint] = useState("");
  const [textBusy, setTextBusy] = useState(false);
  const [textResult, setTextResult] = useState<
    { state: "queued" | "replayed" | "error"; message?: string } | null
  >(null);

  const workspaceId = current?.id;

  const uploadOne = useCallback(
    async (row: FileRowStatus) => {
      if (!workspaceId) return;
      setFileRows((prev) =>
        prev.map((r) => (r.id === row.id ? { ...r, state: "uploading" } : r)),
      );
      try {
        const res = await ingestionsApi.importFile(workspaceId, row.file, {
          titleHint: fileTitleHint || undefined,
        });
        setFileRows((prev) =>
          prev.map((r) =>
            r.id === row.id
              ? {
                  ...r,
                  state: res.replayed ? "replayed" : "queued",
                  ingestionId: res.id,
                }
              : r,
          ),
        );
      } catch (err) {
        const code = err instanceof ApiError ? err.code : undefined;
        const message =
          err instanceof ApiError ? err.message : "errorNetwork";
        setFileRows((prev) =>
          prev.map((r) =>
            r.id === row.id
              ? {
                  ...r,
                  state: "error",
                  message: t(mapErrorCode(code, "errorNetwork")) + ": " + message,
                }
              : r,
          ),
        );
      }
    },
    [fileTitleHint, t, workspaceId],
  );

  const enqueueFiles = useCallback(
    (files: FileList | File[]) => {
      const arr = Array.from(files);
      if (arr.length === 0) return;
      const newRows: FileRowStatus[] = arr.map((file) => ({
        id: genId(),
        file,
        state: "pending",
      }));
      setFileRows((prev) => [...newRows, ...prev]);
      // Upload sequentially to avoid thrashing the rate-limit bucket
      (async () => {
        for (const row of newRows) {
          await uploadOne(row);
        }
      })();
    },
    [uploadOne],
  );

  const handleBrowse = () => fileInputRef.current?.click();

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files) enqueueFiles(e.dataTransfer.files);
  };

  const handleUrlSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!workspaceId || !url.trim()) return;
    setUrlBusy(true);
    setUrlResult(null);
    try {
      const res = await ingestionsApi.importUrl(workspaceId, {
        url: url.trim(),
        mode: "readable",
        titleHint: urlTitleHint || undefined,
        forceRefresh: urlForce || undefined,
      });
      setUrlResult({ state: res.replayed ? "replayed" : "queued" });
      setUrl("");
      setUrlTitleHint("");
      setUrlForce(false);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : undefined;
      const message =
        err instanceof ApiError ? err.message : "errorNetwork";
      setUrlResult({
        state: "error",
        message: t(mapErrorCode(code, "errorNetwork")) + ": " + message,
      });
    } finally {
      setUrlBusy(false);
    }
  };

  const handleTextSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!workspaceId || !text.trim()) return;
    setTextBusy(true);
    setTextResult(null);
    try {
      const res = await ingestionsApi.importText(workspaceId, {
        content: text,
        titleHint: textTitleHint || undefined,
      });
      setTextResult({ state: res.replayed ? "replayed" : "queued" });
      setText("");
      setTextTitleHint("");
    } catch (err) {
      const code = err instanceof ApiError ? err.code : undefined;
      const message =
        err instanceof ApiError ? err.message : "errorNetwork";
      setTextResult({
        state: "error",
        message: t(mapErrorCode(code, "errorNetwork")) + ": " + message,
      });
    } finally {
      setTextBusy(false);
    }
  };

  const statusLabel = (state: FileRowStatus["state"]) => {
    switch (state) {
      case "pending":
        return t("statusPending");
      case "uploading":
        return t("statusUploading");
      case "queued":
        return t("statusQueued");
      case "replayed":
        return t("statusReplayed");
      case "error":
        return t("statusError");
    }
  };

  if (!current) return null;

  return (
    <div className="import-page">
      <div className="import-header">
        <h1>{t("title")}</h1>
        <p className="import-subtitle">{t("subtitle")}</p>
      </div>

      <div className="import-tabs">
        {(["file", "url", "text"] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            className={`import-tab${activeTab === tab ? " active" : ""}`}
            onClick={() => setActiveTab(tab)}
          >
            {t(
              tab === "file" ? "tabFile" : tab === "url" ? "tabUrl" : "tabText",
            )}
          </button>
        ))}
      </div>

      <div className="import-body">
        {activeTab === "file" && (
          <div className="import-panel">
            <div
              className={`import-dropzone${isDragging ? " active" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
              onClick={handleBrowse}
              role="button"
              tabIndex={0}
            >
              <p className="import-drop-hint">{t("fileDropHint")}</p>
              <p className="import-drop-types">
                {t("fileTypes", { sizeMb: SIZE_MB })}
              </p>
              <button
                type="button"
                className="import-primary-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  handleBrowse();
                }}
              >
                {t("fileButton")}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={ACCEPT_LIST}
                style={{ display: "none" }}
                onChange={(e) => {
                  if (e.target.files) enqueueFiles(e.target.files);
                  e.target.value = "";
                }}
              />
            </div>
            <label className="import-field">
              <span className="import-field-label">{t("titleHint")}</span>
              <input
                type="text"
                className="import-input"
                value={fileTitleHint}
                onChange={(e) => setFileTitleHint(e.target.value)}
                placeholder={t("titleHintPlaceholder")}
                maxLength={500}
              />
            </label>

            {fileRows.length > 0 && (
              <div className="import-row-list">
                {fileRows.map((row) => (
                  <div
                    key={row.id}
                    className={`import-row import-row-${row.state}`}
                  >
                    <div className="import-row-name">{row.file.name}</div>
                    <div className="import-row-meta">
                      <span className="import-row-size">
                        {(row.file.size / 1024).toFixed(1)} KB
                      </span>
                      <span className="import-row-status">
                        {statusLabel(row.state)}
                      </span>
                    </div>
                    {row.message && (
                      <div className="import-row-message">{row.message}</div>
                    )}
                  </div>
                ))}
                {fileRows.some(
                  (r) => r.state === "queued" || r.state === "replayed",
                ) && (
                  <button
                    type="button"
                    className="import-link-btn"
                    onClick={() => navigate("/review")}
                  >
                    {t("successCta")}
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {activeTab === "url" && (
          <form className="import-panel" onSubmit={handleUrlSubmit}>
            <label className="import-field">
              <span className="import-field-label">{t("urlLabel")}</span>
              <input
                type="url"
                className="import-input"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder={t("urlPlaceholder")}
                required
                maxLength={2048}
              />
            </label>
            <label className="import-field">
              <span className="import-field-label">{t("titleHint")}</span>
              <input
                type="text"
                className="import-input"
                value={urlTitleHint}
                onChange={(e) => setUrlTitleHint(e.target.value)}
                placeholder={t("titleHintPlaceholder")}
                maxLength={500}
              />
            </label>
            <label className="import-checkbox">
              <input
                type="checkbox"
                checked={urlForce}
                onChange={(e) => setUrlForce(e.target.checked)}
              />
              <span>{t("urlForceRefresh")}</span>
            </label>
            <button
              type="submit"
              className="import-primary-btn"
              disabled={urlBusy || !url.trim()}
            >
              {t("urlSubmit")}
            </button>
            {urlResult && (
              <div className={`import-result import-result-${urlResult.state}`}>
                {urlResult.state === "queued" && t("statusQueued")}
                {urlResult.state === "replayed" && t("statusReplayed")}
                {urlResult.state === "error" && urlResult.message}
                {(urlResult.state === "queued" ||
                  urlResult.state === "replayed") && (
                  <button
                    type="button"
                    className="import-link-btn"
                    onClick={() => navigate("/review")}
                  >
                    {t("successCta")}
                  </button>
                )}
              </div>
            )}
          </form>
        )}

        {activeTab === "text" && (
          <form className="import-panel" onSubmit={handleTextSubmit}>
            <label className="import-field">
              <span className="import-field-label">{t("titleHint")}</span>
              <input
                type="text"
                className="import-input"
                value={textTitleHint}
                onChange={(e) => setTextTitleHint(e.target.value)}
                placeholder={t("titleHintPlaceholder")}
                maxLength={500}
              />
            </label>
            <label className="import-field">
              <span className="import-field-label">{t("textLabel")}</span>
              <textarea
                className="import-textarea"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={t("textPlaceholder")}
                rows={14}
                maxLength={1_000_000}
              />
            </label>
            <button
              type="submit"
              className="import-primary-btn"
              disabled={textBusy || !text.trim()}
            >
              {t("textSubmit")}
            </button>
            {textResult && (
              <div className={`import-result import-result-${textResult.state}`}>
                {textResult.state === "queued" && t("statusQueued")}
                {textResult.state === "replayed" && t("statusReplayed")}
                {textResult.state === "error" && textResult.message}
                {(textResult.state === "queued" ||
                  textResult.state === "replayed") && (
                  <button
                    type="button"
                    className="import-link-btn"
                    onClick={() => navigate("/review")}
                  >
                    {t("successCta")}
                  </button>
                )}
              </div>
            )}
          </form>
        )}
      </div>
    </div>
  );
}
