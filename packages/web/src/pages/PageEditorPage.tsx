import { useState, useEffect, useRef, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useWorkspace } from "../hooks/use-workspace.js";
import {
  ApiError,
  pages as pagesApi,
  type Page,
  type PublishScope,
  type Revision,
  type PublishedSnapshotSummary,
} from "../lib/api-client.js";
import {
  TiptapEditor,
  type TiptapEditorHandle,
} from "../components/editor/TiptapEditor.js";
import { RevisionHistoryPanel } from "../components/revisions/RevisionHistoryPanel.js";
import { GraphPanel } from "../components/graph/GraphPanel.js";
import { FreshnessBadge } from "../components/editor/FreshnessBadge.js";

type EditorMode = "block" | "source";
const PUBLISH_SUBTREE_PAGE_LIMIT = 100;

async function countDescendantPages(
  workspaceId: string,
  rootPageId: string,
): Promise<number> {
  const seen = new Set<string>([rootPageId]);
  const queue = [rootPageId];
  let count = 0;

  for (
    let index = 0;
    index < queue.length && count < PUBLISH_SUBTREE_PAGE_LIMIT;
    index += 1
  ) {
    const parentPageId = queue[index];
    let offset = 0;

    while (count < PUBLISH_SUBTREE_PAGE_LIMIT) {
      const res = await pagesApi.list(workspaceId, {
        parentPageId,
        limit: 500,
        offset,
      });

      for (const child of res.data) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        queue.push(child.id);
        count += 1;
        if (count >= PUBLISH_SUBTREE_PAGE_LIMIT) break;
      }

      if (res.data.length === 0 || offset + res.data.length >= res.total) {
        break;
      }
      offset += res.data.length;
    }
  }

  return count;
}

export function PageEditorPage() {
  const { t } = useTranslation(["editor", "common"]);
  const { pageId } = useParams<{ pageId: string }>();
  const { current: workspace } = useWorkspace();
  const navigate = useNavigate();

  const [page, setPage] = useState<Page | null>(null);
  const [revision, setRevision] = useState<Revision | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [mode, setMode] = useState<EditorMode>("block");
  const [markdown, setMarkdown] = useState("");
  const [dirty, setDirty] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [graphOpen, setGraphOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishScope, setPublishScope] = useState<PublishScope>("self");
  const [descendantCount, setDescendantCount] = useState(0);
  const [descendantCountLoading, setDescendantCountLoading] = useState(false);
  const [publishResult, setPublishResult] = useState<
    | {
        status: "success";
        snapshot: PublishedSnapshotSummary | null;
        scope: PublishScope;
        total: number;
        publishedCount: number;
        skippedCount: number;
        failedCount: number;
      }
    | { status: "error"; message?: string }
    | { status: "confirm" }
    | null
  >(null);
  const [reformatting, setReformatting] = useState(false);
  const [reformatResult, setReformatResult] = useState<
    | { status: "queued" }
    | { status: "already_pending"; decisionId: string }
    | { status: "error" }
    | null
  >(null);

  const editorRef = useRef<TiptapEditorHandle>(null);
  const saveRef = useRef<() => void>(() => {});
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!workspace || !pageId) return;
    let cancelled = false;
    setLoading(true);

    pagesApi
      .get(workspace.id, pageId)
      .then((res) => {
        if (cancelled) return;
        setPage(res.page);
        setRevision(res.currentRevision);
        setMarkdown(res.currentRevision?.contentMd ?? "");
      })
      .catch(() => {
        if (!cancelled) navigate("/");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [workspace, pageId, navigate]);

  useEffect(() => {
    if (!workspace || !pageId) return;
    let cancelled = false;

    setDescendantCount(0);
    setDescendantCountLoading(true);
    countDescendantPages(workspace.id, pageId)
      .then((count) => {
        if (!cancelled) setDescendantCount(count);
      })
      .catch(() => {
        if (!cancelled) setDescendantCount(0);
      })
      .finally(() => {
        if (!cancelled) setDescendantCountLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [workspace, pageId]);

  const scheduleAutosave = useCallback(() => {
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = setTimeout(() => saveRef.current(), 2000);
  }, []);

  const handleEditorChange = useCallback(
    (md: string) => {
      setMarkdown(md);
      setDirty(true);
      scheduleAutosave();
    },
    [scheduleAutosave],
  );

  const handleSourceChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setMarkdown(e.target.value);
      setDirty(true);
      scheduleAutosave();
    },
    [scheduleAutosave],
  );

  const toggleMode = useCallback(() => {
    if (mode === "block") {
      if (editorRef.current) {
        setMarkdown(editorRef.current.getMarkdown());
      }
      setMode("source");
    } else {
      if (editorRef.current) {
        editorRef.current.setMarkdown(markdown);
      }
      setMode("block");
    }
  }, [mode, markdown]);

  const save = useCallback(async () => {
    if (!workspace || !pageId || saving) return;

    let contentMd = markdown;
    let contentJson: Record<string, unknown> | undefined;

    if (mode === "block" && editorRef.current) {
      contentJson = editorRef.current.getJSON();
    }

    setSaving(true);
    try {
      const res = await pagesApi.createRevision(workspace.id, pageId, {
        contentMd,
        contentJson,
      });
      setRevision(res.revision);
      setPage((p) =>
        p ? { ...p, lastHumanEditedAt: res.revision.createdAt } : p,
      );
      setDirty(false);
    } finally {
      setSaving(false);
    }
  }, [workspace, pageId, saving, markdown, mode]);

  const refreshPage = useCallback(async () => {
    if (!workspace || !pageId) return;
    const res = await pagesApi.get(workspace.id, pageId);
    setPage(res.page);
    setRevision(res.currentRevision);
    const md = res.currentRevision?.contentMd ?? "";
    setMarkdown(md);
    setDirty(false);
    if (editorRef.current) {
      editorRef.current.setMarkdown(md);
    }
  }, [workspace, pageId]);

  const handlePublishClick = useCallback(() => {
    setPublishResult({ status: "confirm" });
  }, []);

  const handleReformatClick = useCallback(async () => {
    if (!workspace || !pageId || reformatting) return;
    setReformatting(true);
    setReformatResult(null);
    try {
      const res = await pagesApi.reformat(workspace.id, pageId);
      if (res.status === "already_pending") {
        setReformatResult({
          status: "already_pending",
          decisionId: res.decisionId ?? "",
        });
      } else {
        setReformatResult({ status: "queued" });
      }
    } catch {
      setReformatResult({ status: "error" });
    } finally {
      setReformatting(false);
    }
  }, [workspace, pageId, reformatting]);

  const handlePublishConfirm = useCallback(async () => {
    if (!workspace || !pageId || publishing) return;

    setPublishResult(null);
    setPublishing(true);
    try {
      const res = await pagesApi.publish(workspace.id, pageId, {
        scope: publishScope,
      });
      setPublishResult({
        status: "success",
        snapshot: res.snapshot,
        scope: res.scope,
        total: res.total,
        publishedCount: res.publishedCount,
        skippedCount: res.skippedCount,
        failedCount: res.failedCount,
      });
      if (res.snapshots.some((snapshot) => snapshot.pageId === pageId)) {
        setPage((p) => (p ? { ...p, status: "published" } : p));
      }
    } catch (err) {
      setPublishResult({
        status: "error",
        message: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setPublishing(false);
    }
  }, [workspace, pageId, publishing, publishScope]);

  saveRef.current = save;

  const subtreePageCount = descendantCount + 1;
  const subtreeTooLarge = subtreePageCount > PUBLISH_SUBTREE_PAGE_LIMIT;

  useEffect(() => {
    if (publishScope === "subtree" && subtreeTooLarge) {
      setPublishScope("self");
    }
  }, [publishScope, subtreeTooLarge]);

  // Cancel pending autosave on unmount
  useEffect(() => {
    return () => {
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    };
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        saveRef.current();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  if (loading) {
    return <div className="page-editor loading">{t("common:loading")}</div>;
  }

  if (!page) {
    return <div className="page-editor">{t("pageNotFound")}</div>;
  }

  return (
    <div
      className={`page-editor${historyOpen ? " with-history" : ""}${graphOpen ? " with-graph" : ""}`}
    >
      <div className="editor-main">
        <div className="editor-header">
          <h1 className="editor-title">{page.title}</h1>
          <div className="editor-header-actions">
            <div className="mode-toggle">
              <button
                className={`mode-btn${mode === "block" ? " active" : ""}`}
                onClick={() => mode !== "block" && toggleMode()}
              >
                {t("block")}
              </button>
              <button
                className={`mode-btn${mode === "source" ? " active" : ""}`}
                onClick={() => mode !== "source" && toggleMode()}
              >
                {t("source")}
              </button>
            </div>
            <button
              className={`mode-btn${graphOpen ? " active" : ""}`}
              onClick={() => {
                setGraphOpen((o) => !o);
                setHistoryOpen(false);
              }}
            >
              {t("graph")}
            </button>
            <button
              className={`mode-btn${historyOpen ? " active" : ""}`}
              onClick={() => {
                setHistoryOpen((o) => !o);
                setGraphOpen(false);
              }}
            >
              {t("history")}
            </button>
            <button
              className="btn-save"
              onClick={save}
              disabled={!dirty || saving}
            >
              {saving ? t("saving") : dirty ? t("save") : t("saved")}
            </button>
            <button
              className="btn-reformat"
              onClick={handleReformatClick}
              disabled={reformatting || loading}
              title="AI가 문서를 검토 후 구조를 재편성합니다"
            >
              {reformatting ? "분석 중..." : "재구성"}
            </button>
            <div className="publish-controls">
              <select
                className="publish-scope-select"
                value={publishScope}
                onChange={(event) => {
                  setPublishScope(event.target.value as PublishScope);
                  setPublishResult(null);
                }}
                disabled={publishing || dirty}
                aria-label={t("publishScopeLabel")}
              >
                <option value="self">{t("publishScopeSelf")}</option>
                <option value="subtree" disabled={subtreeTooLarge}>
                  {descendantCountLoading
                    ? t("publishScopeSubtreeLoading")
                    : subtreeTooLarge
                      ? t("publishScopeSubtreeTooLarge", {
                          limit: PUBLISH_SUBTREE_PAGE_LIMIT,
                        })
                      : t("publishScopeSubtree", { count: subtreePageCount })}
                </option>
              </select>
              <button
                className="btn-publish"
                onClick={handlePublishClick}
                disabled={
                  publishing ||
                  dirty ||
                  (publishScope === "subtree" &&
                    (descendantCountLoading || subtreeTooLarge))
                }
                title={
                  dirty
                    ? t("save")
                    : publishScope === "subtree" && subtreeTooLarge
                      ? t("publishScopeTooLargeTitle", {
                          limit: PUBLISH_SUBTREE_PAGE_LIMIT,
                        })
                      : undefined
                }
              >
                {publishing ? t("publishing") : t("publish")}
              </button>
            </div>
          </div>
        </div>

        {(reformatResult?.status === "queued" ||
          reformatResult?.status === "already_pending") && (
          <div className="publish-banner">
            <span>
              {reformatResult.status === "queued"
                ? "AI가 재구성 중입니다. 잠시 후 신규 지식 → 전체 탭에서 확인하세요."
                : "이미 검토 대기 중인 재구성 요청이 있습니다."}
            </span>
            <button
              className="publish-banner-link"
              onClick={() => navigate("/review")}
            >
              제안됨 탭 열기
            </button>
            <button
              className="btn-close-panel"
              onClick={() => setReformatResult(null)}
            >
              &times;
            </button>
          </div>
        )}

        {reformatResult?.status === "error" && (
          <div className="publish-banner publish-banner-error">
            <span>재구성 요청에 실패했습니다. 다시 시도해주세요.</span>
            <button
              className="btn-close-panel"
              onClick={() => setReformatResult(null)}
            >
              &times;
            </button>
          </div>
        )}

        {publishResult?.status === "confirm" && (
          <div className="publish-banner publish-banner-confirm">
            <span>
              {publishScope === "subtree"
                ? t("publishSubtreeConfirm", { count: subtreePageCount })
                : t("publishConfirm")}
            </span>
            <button
              className="btn-primary btn-sm"
              onClick={handlePublishConfirm}
            >
              {t("publish")}
            </button>
            <button className="btn-sm" onClick={() => setPublishResult(null)}>
              {t("common:cancel")}
            </button>
          </div>
        )}

        {publishResult?.status === "success" && (
          <div className="publish-banner">
            <span>
              {publishResult.scope === "subtree"
                ? t("publishSubtreeSuccess", {
                    published: publishResult.publishedCount,
                    total: publishResult.total,
                    skipped: publishResult.skippedCount,
                    failed: publishResult.failedCount,
                  })
                : t("publishSuccess")}
            </span>
            {publishResult.snapshot && (
              <a
                href={publishResult.snapshot.publicPath}
                target="_blank"
                rel="noopener noreferrer"
                className="publish-banner-link"
              >
                {t("viewPublished")}
              </a>
            )}
            <button
              className="btn-close-panel"
              onClick={() => setPublishResult(null)}
            >
              &times;
            </button>
          </div>
        )}

        {publishResult?.status === "error" && (
          <div className="publish-banner publish-banner-error">
            <span>
              {publishResult.message
                ? t("publishFailedWithReason", {
                    reason: publishResult.message,
                  })
                : t("publishFailed")}
            </span>
            <button
              className="btn-close-panel"
              onClick={() => setPublishResult(null)}
            >
              &times;
            </button>
          </div>
        )}

        <div className="editor-area">
          {mode === "block" ? (
            <TiptapEditor
              ref={editorRef}
              initialContent={markdown}
              onChange={handleEditorChange}
            />
          ) : (
            <textarea
              className="source-editor"
              value={markdown}
              onChange={handleSourceChange}
              spellCheck={false}
            />
          )}
        </div>

        <div className="editor-status">
          <span>
            {revision
              ? t("lastSaved", {
                  date: new Date(revision.createdAt).toLocaleString(),
                })
              : t("newPageStatus")}
          </span>
          {page && (
            <FreshnessBadge
              lastAiUpdatedAt={page.lastAiUpdatedAt}
              lastHumanEditedAt={page.lastHumanEditedAt}
            />
          )}
          {dirty && (
            <span className="unsaved-indicator">{t("unsavedChanges")}</span>
          )}
        </div>
      </div>

      {graphOpen && workspace && pageId && (
        <GraphPanel
          workspaceId={workspace.id}
          pageId={pageId}
          onClose={() => setGraphOpen(false)}
          onNavigateToPage={(targetPageId) =>
            navigate(`/pages/${targetPageId}`)
          }
        />
      )}

      {historyOpen && workspace && pageId && (
        <RevisionHistoryPanel
          workspaceId={workspace.id}
          pageId={pageId}
          currentRevisionId={revision?.id ?? null}
          onClose={() => setHistoryOpen(false)}
          onRollback={refreshPage}
        />
      )}
    </div>
  );
}
