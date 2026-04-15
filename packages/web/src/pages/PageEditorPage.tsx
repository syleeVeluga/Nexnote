import { useState, useEffect, useRef, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useWorkspace } from "../hooks/use-workspace.js";
import {
  pages as pagesApi,
  type Page,
  type Revision,
} from "../lib/api-client.js";
import {
  TiptapEditor,
  type TiptapEditorHandle,
} from "../components/editor/TiptapEditor.js";
import { RevisionHistoryPanel } from "../components/revisions/RevisionHistoryPanel.js";

type EditorMode = "block" | "source";

export function PageEditorPage() {
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

  const editorRef = useRef<TiptapEditorHandle>(null);
  const saveRef = useRef<() => void>(() => {});

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

    return () => { cancelled = true; };
  }, [workspace, pageId, navigate]);

  const handleEditorChange = useCallback((md: string) => {
    setMarkdown(md);
    setDirty(true);
  }, []);

  const handleSourceChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setMarkdown(e.target.value);
      setDirty(true);
    },
    [],
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

  // Keep saveRef current so the keyboard handler doesn't need to re-bind
  saveRef.current = save;

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
    return <div className="page-editor loading">Loading...</div>;
  }

  if (!page) {
    return <div className="page-editor">Page not found</div>;
  }

  return (
    <div className={`page-editor${historyOpen ? " with-history" : ""}`}>
      <div className="editor-main">
        <div className="editor-header">
          <h1 className="editor-title">{page.title}</h1>
          <div className="editor-header-actions">
            <div className="mode-toggle">
              <button
                className={`mode-btn${mode === "block" ? " active" : ""}`}
                onClick={() => mode !== "block" && toggleMode()}
              >
                Block
              </button>
              <button
                className={`mode-btn${mode === "source" ? " active" : ""}`}
                onClick={() => mode !== "source" && toggleMode()}
              >
                Source
              </button>
            </div>
            <button
              className={`mode-btn${historyOpen ? " active" : ""}`}
              onClick={() => setHistoryOpen((o) => !o)}
            >
              History
            </button>
            <button
              className="btn-save"
              onClick={save}
              disabled={!dirty || saving}
            >
              {saving ? "Saving..." : dirty ? "Save" : "Saved"}
            </button>
          </div>
        </div>

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
              ? `Last saved: ${new Date(revision.createdAt).toLocaleString()}`
              : "New page"}
          </span>
          {dirty && <span className="unsaved-indicator">Unsaved changes</span>}
        </div>
      </div>

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
