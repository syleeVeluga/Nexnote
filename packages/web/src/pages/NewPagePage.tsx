import { useState, useEffect, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { slugify } from "@nexnote/shared";
import { useWorkspace } from "../hooks/use-workspace.js";
import { pages as pagesApi, folders as foldersApi, ApiError, type Folder } from "../lib/api-client.js";

export function NewPagePage() {
  const { t } = useTranslation("pages");
  const { current: workspace } = useWorkspace();
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [slugManual, setSlugManual] = useState(false);
  const [folderId, setFolderId] = useState<string>("");
  const [folderList, setFolderList] = useState<Folder[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!workspace) return;
    foldersApi
      .list(workspace.id, { limit: 200 })
      .then((res) => setFolderList(res.data))
      .catch(() => {});
  }, [workspace]);

  function handleTitleChange(value: string) {
    setTitle(value);
    if (!slugManual) {
      setSlug(slugify(value));
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!workspace) return;

    setError("");
    setBusy(true);
    try {
      const res = await pagesApi.create(workspace.id, {
        title,
        slug: slug || slugify(title),
        folderId: folderId || null,
        contentMd: `# ${title}\n`,
      });
      navigate(`/pages/${res.page.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("createFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="new-page">
      <form className="new-page-form" onSubmit={handleSubmit}>
        <h1>{t("newPage")}</h1>
        {error && <div className="form-error">{error}</div>}
        <label>
          {t("titleLabel")}
          <input
            type="text"
            value={title}
            onChange={(e) => handleTitleChange(e.target.value)}
            required
            autoFocus
            placeholder={t("titlePlaceholder")}
          />
        </label>
        <label>
          {t("slugLabel")}
          <input
            type="text"
            value={slug}
            onChange={(e) => {
              setSlug(e.target.value);
              setSlugManual(true);
            }}
            required
            placeholder={t("slugPlaceholder")}
          />
        </label>
        <label>
          {t("folderLabel")}
          <select
            value={folderId}
            onChange={(e) => setFolderId(e.target.value)}
          >
            <option value="">{t("noFolder")}</option>
            {folderList.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
        <div className="form-actions">
          <button type="button" onClick={() => navigate(-1)}>
            {t("common:cancel")}
          </button>
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? t("creating") : t("createPage")}
          </button>
        </div>
      </form>
    </div>
  );
}
