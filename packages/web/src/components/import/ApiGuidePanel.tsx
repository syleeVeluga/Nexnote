import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

type LangKey = "js" | "curl" | "python";

interface Props {
  workspaceId: string;
}

export function ApiGuidePanel({ workspaceId }: Props) {
  const { t } = useTranslation("import");
  const navigate = useNavigate();
  const [activeLang, setActiveLang] = useState<LangKey>("js");
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const origin = window.location.origin;

  const codeExamples: Record<LangKey, string> = {
    js: `const BASE = '${origin}/api/v1';

// Step 1: Login and get a JWT
const { token } = await fetch(\`\${BASE}/auth/login\`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'you@example.com', password: 'yourpassword' }),
}).then(r => r.json());

// Step 2: Send knowledge to NexNote
const { id, replayed } = await fetch(
  \`\${BASE}/workspaces/${workspaceId}/ingestions\`,
  {
    method: 'POST',
    headers: {
      'Authorization': \`Bearer \${token}\`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      sourceName: 'my-agent',
      idempotencyKey: 'unique-key-for-this-doc',
      contentType: 'text/markdown',
      titleHint: 'Document Title',       // optional
      rawPayload: { text: '## Heading\\n\\nContent here...' },
    }),
  }
).then(r => r.json());
// replayed: true → already queued (idempotent — safe to ignore)`,

    curl: `# Step 1: Login and capture the JWT
TOKEN=$(curl -s -X POST '${origin}/api/v1/auth/login' \\
  -H 'Content-Type: application/json' \\
  -d '{"email":"you@example.com","password":"yourpassword"}' \\
  | jq -r '.token')

# Step 2: Send knowledge to NexNote
curl -s -X POST '${origin}/api/v1/workspaces/${workspaceId}/ingestions' \\
  -H "Authorization: Bearer $TOKEN" \\
  -H 'Content-Type: application/json' \\
  -d '{
    "sourceName": "my-agent",
    "idempotencyKey": "unique-key-for-this-doc",
    "contentType": "text/markdown",
    "titleHint": "Document Title",
    "rawPayload": { "text": "## Heading\\n\\nContent here..." }
  }'`,

    python: `import requests

BASE = '${origin}/api/v1'

# Step 1: Login and get a JWT
token = requests.post(f'{BASE}/auth/login', json={
    'email': 'you@example.com',
    'password': 'yourpassword',
}).json()['token']

# Step 2: Send knowledge to NexNote
res = requests.post(
    f'{BASE}/workspaces/${workspaceId}/ingestions',
    headers={'Authorization': f'Bearer {token}'},
    json={
        'sourceName': 'my-agent',
        'idempotencyKey': 'unique-key-for-this-doc',
        'contentType': 'text/markdown',
        'titleHint': 'Document Title',          # optional
        'rawPayload': {'text': '## Heading\\n\\nContent here...'},
    },
)
data = res.json()
# data['replayed'] == True → already queued (idempotent — safe to ignore)`,
  };

  useEffect(() => {
    if (!copiedKey) return;
    const timer = setTimeout(() => setCopiedKey(null), 1500);
    return () => clearTimeout(timer);
  }, [copiedKey]);

  const copy = async (text: string, key: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedKey(key);
  };

  return (
    <div className="api-guide-panel">
      <p className="api-guide-desc">{t("apiGuideDesc")}</p>

      <div className="api-guide-workspace-row">
        <span className="api-guide-workspace-label">
          {t("apiGuideWorkspaceId")}
        </span>
        <code className="api-guide-workspace-id-val">{workspaceId}</code>
        <button
          type="button"
          className="api-guide-copy-btn"
          onClick={() => copy(workspaceId, "wid")}
        >
          {copiedKey === "wid" ? t("apiGuideCopied") : t("apiGuideCopy")}
        </button>
      </div>

      {(
        [
          ["apiGuideStep1", "apiGuideStep1Desc"],
          ["apiGuideStep2", "apiGuideStep2Desc"],
        ] as const
      ).map(([titleKey, descKey]) => (
        <div key={titleKey} className="api-guide-section">
          <h3 className="api-guide-section-title">{t(titleKey)}</h3>
          <p className="api-guide-section-desc">{t(descKey)}</p>
        </div>
      ))}

      <div className="api-guide-code-container">
        <div className="api-guide-langs">
          {(["js", "curl", "python"] as LangKey[]).map((lang) => (
            <button
              key={lang}
              type="button"
              className={`api-guide-lang${activeLang === lang ? " active" : ""}`}
              onClick={() => setActiveLang(lang)}
            >
              {lang === "js"
                ? "JavaScript"
                : lang === "curl"
                  ? "cURL"
                  : "Python"}
            </button>
          ))}
          <button
            type="button"
            className="api-guide-copy-btn api-guide-copy-float"
            onClick={() => copy(codeExamples[activeLang], "code")}
          >
            {copiedKey === "code" ? t("apiGuideCopied") : t("apiGuideCopy")}
          </button>
        </div>
        <pre className="api-guide-code">
          <code>{codeExamples[activeLang]}</code>
        </pre>
      </div>

      <div className="api-guide-section">
        <h3 className="api-guide-section-title">{t("apiGuideRequest")}</h3>
        <table className="api-guide-fields">
          <tbody>
            <tr>
              <td>
                <code>sourceName</code>
              </td>
              <td>{t("apiGuideFieldSourceName")}</td>
            </tr>
            <tr>
              <td>
                <code>idempotencyKey</code>
              </td>
              <td>{t("apiGuideFieldIdempotencyKey")}</td>
            </tr>
            <tr>
              <td>
                <code>contentType</code>
              </td>
              <td>{t("apiGuideFieldContentType")}</td>
            </tr>
            <tr>
              <td>
                <code>titleHint</code>
              </td>
              <td>{t("apiGuideFieldTitleHint")}</td>
            </tr>
            <tr>
              <td>
                <code>rawPayload</code>
              </td>
              <td>{t("apiGuideFieldRawPayload")}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="api-guide-info-box">
        <strong>{t("apiGuideResponse")}</strong>
        <p>{t("apiGuideResponseDesc")}</p>
      </div>

      <div className="api-guide-info-box api-guide-info-box-warn">
        <strong>{t("apiGuideRateLimits")}</strong>
        <p>{t("apiGuideRateLimitsDesc")}</p>
      </div>

      <button
        type="button"
        className="import-link-btn"
        onClick={() => navigate("/review")}
      >
        {t("apiGuideReviewCta")}
      </button>
    </div>
  );
}
