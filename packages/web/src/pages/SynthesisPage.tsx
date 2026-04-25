// Not wired into routing. Retained for reference only.
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useWorkspace } from "../hooks/use-workspace.js";
import { synthesis as synthesisApi } from "../lib/api-client.js";

export function SynthesisPage() {
  const { current } = useWorkspace();
  const navigate = useNavigate();
  const [titleHint, setTitleHint] = useState("");
  const [prompt, setPrompt] = useState("");
  const [sourceText, setSourceText] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!current || !prompt.trim() || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      await synthesisApi.create(current.id, {
        prompt: prompt.trim(),
        titleHint: titleHint.trim() || undefined,
        sourceText: sourceText.trim() || undefined,
      });
      setPrompt("");
      setSourceText("");
      setTitleHint("");
      setMessage("AI 생성 제안을 만들고 있습니다. 완료되면 검토 대기열에 표시됩니다.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "요청에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  };

  if (!current) return null;

  return (
    <div className="synthesis-page">
      <div className="synthesis-header">
        <div>
          <h1>AI 생성 문서</h1>
          <p>
            긴 원문은 먼저 저장한 뒤 chunk/evidence pack으로 줄여서 처리합니다.
            결과는 승인 전까지 일반 페이지 목록에 섞이지 않습니다.
          </p>
        </div>
        <button className="btn btn-secondary" onClick={() => navigate("/review")}>
          검토 대기열
        </button>
      </div>

      <form className="synthesis-form" onSubmit={submit}>
        <label>
          문서 제목
          <input
            value={titleHint}
            onChange={(event) => setTitleHint(event.target.value)}
            placeholder="예: 2026년 제품 전략 종합"
          />
        </label>

        <label>
          생성 지시
          <textarea
            rows={5}
            required
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="어떤 관점으로 종합 문서를 작성할지 적어주세요."
          />
        </label>

        <label>
          원문 또는 참고 자료
          <textarea
            rows={14}
            value={sourceText}
            onChange={(event) => setSourceText(event.target.value)}
            placeholder="매우 긴 문서를 붙여도 됩니다. 전체 원문은 바로 AI에 보내지 않고 evidence chunk로 축약됩니다."
          />
        </label>

        {message && <div className="synthesis-message">{message}</div>}

        <div className="synthesis-actions">
          <button className="btn btn-primary" disabled={busy || !prompt.trim()}>
            {busy ? "요청 중..." : "AI 생성 제안 만들기"}
          </button>
        </div>
      </form>
    </div>
  );
}
