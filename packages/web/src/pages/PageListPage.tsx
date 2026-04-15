import { useState, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useWorkspace } from "../hooks/use-workspace.js";
import { pages as pagesApi, type Page } from "../lib/api-client.js";

export function PageListPage() {
  const { current } = useWorkspace();
  const navigate = useNavigate();
  const [pageList, setPageList] = useState<Page[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!current) return;
    let cancelled = false;
    setLoading(true);
    pagesApi
      .list(current.id, { limit: 50 })
      .then((res) => {
        if (!cancelled) {
          setPageList(res.data);
          setTotal(res.total);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [current]);

  if (!current) return null;

  return (
    <div className="page-list">
      <div className="page-list-header">
        <h1>Pages</h1>
        <button
          className="btn-primary"
          onClick={() => navigate("/pages/new")}
        >
          + New Page
        </button>
      </div>
      {loading ? (
        <p className="loading">Loading...</p>
      ) : pageList.length === 0 ? (
        <div className="empty-state">
          <p>No pages yet. Create your first page to get started.</p>
        </div>
      ) : (
        <>
          <table className="page-table">
            <thead>
              <tr>
                <th>Title</th>
                <th>Status</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {pageList.map((page) => (
                <tr
                  key={page.id}
                  className="page-row"
                  onClick={() => navigate(`/pages/${page.id}`)}
                >
                  <td>
                    <Link to={`/pages/${page.id}`} className="page-title-link">
                      {page.title || "Untitled"}
                    </Link>
                  </td>
                  <td>
                    <span className={`badge badge-${page.status}`}>
                      {page.status}
                    </span>
                  </td>
                  <td className="date-cell">
                    {new Date(page.updatedAt).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {total > pageList.length && (
            <p className="page-list-total">
              Showing {pageList.length} of {total} pages
            </p>
          )}
        </>
      )}
    </div>
  );
}
