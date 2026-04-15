import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "../hooks/use-auth.js";
import { ApiError } from "../lib/api-client.js";

export function RegisterPage() {
  const { t } = useTranslation("auth");
  const { register } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await register(email, password, name);
      navigate("/");
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : t("registrationFailed"),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <form className="auth-form" onSubmit={handleSubmit}>
        <h1>{t("createAccount")}</h1>
        {error && <div className="form-error">{error}</div>}
        <label>
          {t("name")}
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            autoFocus
          />
        </label>
        <label>
          {t("email")}
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>
        <label>
          {t("password")}
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
          />
        </label>
        <button type="submit" disabled={busy}>
          {busy ? t("creatingAccount") : t("createAccountBtn")}
        </button>
        <p className="auth-switch">
          {t("hasAccount")} <Link to="/login">{t("signIn")}</Link>
        </p>
      </form>
    </div>
  );
}
