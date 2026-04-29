import { useCallback, useEffect, useState } from "react";
import { Ban, Check, Copy, KeyRound, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useWorkspace } from "../hooks/use-workspace.js";
import {
  apiTokens as apiTokensApi,
  type ApiTokenItem,
  type ApiTokenScope,
} from "../lib/api-client.js";
import { PageShell } from "../components/ui/PageShell.js";
import { Badge } from "../components/ui/Badge.js";

const DEFAULT_SCOPE: ApiTokenScope = "ingestions:write";

export function ApiTokensPage() {
  const { t } = useTranslation(["common"]);
  const { current } = useWorkspace();
  const [items, setItems] = useState<ApiTokenItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [sourceNameHint, setSourceNameHint] = useState("");
  const [includeIngestionScope, setIncludeIngestionScope] = useState(true);
  const [creating, setCreating] = useState(false);
  const [revealedToken, setRevealedToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const workspaceId = current?.id;
  const canManage = current?.role === "owner" || current?.role === "admin";

  const load = useCallback(async () => {
    if (!workspaceId || !canManage) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiTokensApi.list(workspaceId, { limit: 100 });
      setItems(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load tokens");
    } finally {
      setLoading(false);
    }
  }, [workspaceId, canManage]);

  useEffect(() => {
    void load();
  }, [load]);

  async function createToken() {
    if (!workspaceId || !name.trim() || !includeIngestionScope) return;
    setCreating(true);
    setError(null);
    setRevealedToken(null);
    try {
      const res = await apiTokensApi.create(workspaceId, {
        name: name.trim(),
        sourceNameHint: sourceNameHint.trim() || null,
        scopes: [DEFAULT_SCOPE],
      });
      setName("");
      setSourceNameHint("");
      setRevealedToken(res.token);
      setCopied(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create token");
    } finally {
      setCreating(false);
    }
  }

  async function revokeToken(token: ApiTokenItem) {
    if (!workspaceId || token.revokedAt) return;
    const ok = window.confirm(`Revoke "${token.name}"?`);
    if (!ok) return;
    try {
      await apiTokensApi.revoke(workspaceId, token.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to revoke token");
    }
  }

  async function copyRevealedToken() {
    if (!revealedToken) return;
    await navigator.clipboard.writeText(revealedToken);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  if (!current) return null;

  if (!canManage) {
    return (
      <PageShell
        className="api-tokens-page"
        title="API Tokens"
        description="Manage external ingestion credentials"
      >
        <div className="system-empty system-empty-restricted">
          {t("insufficientRole", {
            defaultValue: "Only workspace owners and admins can manage tokens.",
          })}
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell
      className="api-tokens-page"
      title="API Tokens"
      description="Create scoped credentials for external ingestion sources"
      actions={
        <Badge tone="blue" size="sm">
          {items.filter((item) => !item.revokedAt).length} active
        </Badge>
      }
    >
      {error && <div className="system-error">{error}</div>}

      <section className="api-token-create">
        <div className="api-token-create-header">
          <span className="system-overview-icon" aria-hidden="true">
            <KeyRound size={18} />
          </span>
          <div>
            <h2>Create token</h2>
            <p>The token value is shown once after creation.</p>
          </div>
        </div>

        <div className="api-token-form">
          <label>
            <span>Name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="CRM webhook"
            />
          </label>
          <label>
            <span>Source name hint</span>
            <input
              value={sourceNameHint}
              onChange={(event) => setSourceNameHint(event.target.value)}
              placeholder="crm-webhook"
            />
          </label>
          <label className="api-token-scope">
            <input
              type="checkbox"
              checked={includeIngestionScope}
              onChange={(event) =>
                setIncludeIngestionScope(event.target.checked)
              }
            />
            <span>ingestions:write</span>
          </label>
          <button
            type="button"
            className="api-token-primary"
            onClick={createToken}
            disabled={!name.trim() || !includeIngestionScope || creating}
          >
            <Plus size={14} aria-hidden="true" />
            {creating ? "Creating..." : "Create"}
          </button>
        </div>

        {revealedToken && (
          <div className="api-token-reveal">
            <div>
              <strong>Copy this token now</strong>
              <p>It will not be shown again.</p>
            </div>
            <code>{revealedToken}</code>
            <button type="button" onClick={copyRevealedToken}>
              {copied ? (
                <Check size={14} aria-hidden="true" />
              ) : (
                <Copy size={14} aria-hidden="true" />
              )}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        )}
      </section>

      <section className="api-token-list">
        <div className="system-section-header">
          <div>
            <h2>Tokens</h2>
            <p>Use active tokens as Authorization: Bearer credentials.</p>
          </div>
          {loading && <Badge tone="warm">Loading</Badge>}
        </div>

        {items.length === 0 && !loading ? (
          <div className="system-empty">No API tokens yet.</div>
        ) : (
          <div className="api-token-table">
            {items.map((item) => (
              <div key={item.id} className="api-token-row">
                <div className="api-token-row-main">
                  <strong>{item.name}</strong>
                  <span>
                    {item.sourceNameHint || "no source hint"} - created by{" "}
                    {item.createdBy.name}
                  </span>
                </div>
                <div className="api-token-scopes">
                  {item.scopes.map((scope) => (
                    <Badge key={scope} tone="teal" size="sm">
                      {scope}
                    </Badge>
                  ))}
                </div>
                <div className="api-token-dates">
                  <span>
                    Created {new Date(item.createdAt).toLocaleDateString()}
                  </span>
                  <span>
                    Last used{" "}
                    {item.lastUsedAt
                      ? new Date(item.lastUsedAt).toLocaleString()
                      : "never"}
                  </span>
                </div>
                <div className="api-token-status">
                  {item.revokedAt ? (
                    <Badge tone="warm" size="sm">
                      revoked
                    </Badge>
                  ) : (
                    <button
                      type="button"
                      className="api-token-revoke"
                      onClick={() => revokeToken(item)}
                    >
                      <Ban size={13} aria-hidden="true" />
                      Revoke
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </PageShell>
  );
}
