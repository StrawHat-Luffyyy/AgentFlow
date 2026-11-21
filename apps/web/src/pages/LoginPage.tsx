import { Eye, EyeOff, Lock, User } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Navigate, useLocation } from "react-router";
import { ApiError } from "../api.js";
import { BrandMark, Button, Field, IconButton, InlineAlert, Input } from "../design/index.js";
import { useSession } from "../lib/session.js";

function signInError(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.status === 401) return "Invalid username or password.";
    if (cause.status === 0 || cause.status >= 500) return "The AgentFlow API could not be reached. Check that it is running.";
    if (cause.status === 404) return "The configured API address is not an AgentFlow API.";
    if (cause.status === 429) return "Too many sign-in attempts. Wait a moment and try again.";
  }
  return "Sign-in failed. Check your credentials and the API connection.";
}

export function LoginPage() {
  const { principal, signIn, notice } = useSession();
  const location = useLocation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const from = (location.state as { from?: string } | null)?.from ?? "/runs";
  if (principal) return <Navigate to={from} replace />;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(username, password);
      setPassword("");
    } catch (cause) {
      setError(signInError(cause));
    } finally {
      setBusy(false);
    }
  }

  const message = error ?? notice;
  return (
    <main className="auth">
      <div className="auth-column">
        <div className="auth-brand"><BrandMark size={28} /><span>AgentFlow</span></div>
        <section className="auth-card" aria-labelledby="sign-in-title">
          <header className="auth-header">
            <h1 id="sign-in-title">Sign in</h1>
            <p>Operate durable agent workflows: inspect runs, recover failures, approve publications.</p>
          </header>
          <form className="auth-form" onSubmit={(event) => void submit(event)}>
            {message && <InlineAlert tone={error ? "danger" : "warning"}>{message}</InlineAlert>}
            <Field label="Username" htmlFor="username">
              <Input id="username" autoComplete="username" required spellCheck={false} autoCapitalize="off"
                leading={<User size={16} />} value={username} disabled={busy} invalid={Boolean(error)}
                onChange={(event) => setUsername(event.target.value)} />
            </Field>
            <Field label="Password" htmlFor="password">
              <Input id="password" type={revealed ? "text" : "password"} autoComplete="current-password" required
                leading={<Lock size={16} />} value={password} disabled={busy} invalid={Boolean(error)}
                onChange={(event) => setPassword(event.target.value)}
                trailing={(
                  <IconButton size="sm" label={revealed ? "Hide password" : "Show password"} onClick={() => setRevealed((value) => !value)}>
                    {revealed ? <EyeOff size={16} /> : <Eye size={16} />}
                  </IconButton>
                )} />
            </Field>
            <Button type="submit" variant="primary" loading={busy} disabled={!username.trim() || !password} className="auth-submit">
              {busy ? "Signing in…" : "Sign in"}
            </Button>
          </form>
        </section>
        <p className="auth-footnote">Sessions use an HTTP-only cookie. Bearer tokens are for the CLI and integrations.</p>
      </div>
    </main>
  );
}
