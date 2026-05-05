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
  const { t, i18n } = useTranslation(["apiTokens", "common"]);
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
  const dateLocale = i18n.language;

  const load = useCallback(async () => {
    if (!workspaceId || !canManage) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiTokensApi.list(workspaceId, { limit: 100 });
      setItems(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("errors.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [workspaceId, canManage, t]);

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
      setError(err instanceof Error ? err.message : t("errors.createFailed"));
    } finally {
      setCreating(false);
    }
  }

  async function revokeToken(token: ApiTokenItem) {
    if (!workspaceId || token.revokedAt) return;
    const ok = window.confirm(t("confirmRevoke", { name: token.name }));
    if (!ok) return;
    setError(null);
    try {
      await apiTokensApi.revoke(workspaceId, token.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("errors.revokeFailed"));
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
        title={t("title")}
        description={t("manageDescription")}
      >
        <div className="system-empty system-empty-restricted">
          {t("insufficientRole")}
        </div>
      </PageShell>
    );
  }

  const activeCount = items.filter((item) => !item.revokedAt).length;

  return (
    <PageShell
      className="api-tokens-page"
      title={t("title")}
      description={t("createDescription")}
      actions={
        <Badge tone="blue" size="sm">
          {t("activeBadge", { count: activeCount })}
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
            <h2>{t("create.heading")}</h2>
            <p>{t("create.subheading")}</p>
          </div>
        </div>

        <div className="api-token-form">
          <label>
            <span>{t("create.nameLabel")}</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t("create.namePlaceholder")}
            />
          </label>
          <label>
            <span>{t("create.sourceHintLabel")}</span>
            <input
              value={sourceNameHint}
              onChange={(event) => setSourceNameHint(event.target.value)}
              placeholder={t("create.sourceHintPlaceholder")}
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
            {creating ? t("create.submitting") : t("create.submit")}
          </button>
        </div>

        {revealedToken && (
          <div className="api-token-reveal">
            <div>
              <strong>{t("reveal.title")}</strong>
              <p>{t("reveal.subtitle")}</p>
            </div>
            <code>{revealedToken}</code>
            <button type="button" onClick={copyRevealedToken}>
              {copied ? (
                <Check size={14} aria-hidden="true" />
              ) : (
                <Copy size={14} aria-hidden="true" />
              )}
              {copied ? t("reveal.copied") : t("reveal.copy")}
            </button>
          </div>
        )}
      </section>

      <section className="api-token-list">
        <div className="system-section-header">
          <div>
            <h2>{t("list.heading")}</h2>
            <p>{t("list.subheading")}</p>
          </div>
          {loading && <Badge tone="warm">{t("list.loading")}</Badge>}
        </div>

        {items.length === 0 && !loading ? (
          <div className="system-empty">{t("list.empty")}</div>
        ) : (
          <div className="api-token-table">
            {items.map((item) => (
              <div key={item.id} className="api-token-row">
                <div className="api-token-row-main">
                  <strong>{item.name}</strong>
                  <span>
                    {t("row.meta", {
                      hint: item.sourceNameHint || t("row.noSourceHint"),
                      creator: item.createdBy.name,
                    })}
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
                    {t("row.createdOn", {
                      date: new Date(item.createdAt).toLocaleDateString(
                        dateLocale,
                      ),
                    })}
                  </span>
                  <span>
                    {t("row.lastUsed", {
                      value: item.lastUsedAt
                        ? new Date(item.lastUsedAt).toLocaleString(dateLocale)
                        : t("row.lastUsedNever"),
                    })}
                  </span>
                </div>
                <div className="api-token-status">
                  {item.revokedAt ? (
                    <Badge tone="warm" size="sm">
                      {t("row.revoked")}
                    </Badge>
                  ) : (
                    <button
                      type="button"
                      className="api-token-revoke"
                      onClick={() => revokeToken(item)}
                    >
                      <Ban size={13} aria-hidden="true" />
                      {t("row.revoke")}
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
