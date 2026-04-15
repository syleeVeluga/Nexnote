import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useWorkspace } from "../hooks/use-workspace.js";
import { pages as pagesApi, ApiError } from "../lib/api-client.js";

function toSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 100);
}

export function NewPagePage() {
  const { current: workspace } = useWorkspace();
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [slugManual, setSlugManual] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  function handleTitleChange(value: string) {
    setTitle(value);
    if (!slugManual) {
      setSlug(toSlug(value));
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
        slug: slug || toSlug(title),
        contentMd: `# ${title}\n`,
      });
      navigate(`/pages/${res.page.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to create page");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="new-page">
      <form className="new-page-form" onSubmit={handleSubmit}>
        <h1>New Page</h1>
        {error && <div className="form-error">{error}</div>}
        <label>
          Title
          <input
            type="text"
            value={title}
            onChange={(e) => handleTitleChange(e.target.value)}
            required
            autoFocus
            placeholder="My awesome document"
          />
        </label>
        <label>
          Slug
          <input
            type="text"
            value={slug}
            onChange={(e) => {
              setSlug(e.target.value);
              setSlugManual(true);
            }}
            required
            placeholder="my-awesome-document"
          />
        </label>
        <div className="form-actions">
          <button type="button" onClick={() => navigate(-1)}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? "Creating..." : "Create page"}
          </button>
        </div>
      </form>
    </div>
  );
}
