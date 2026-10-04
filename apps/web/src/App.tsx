import {
  Activity,
  Check,
  ChevronRight,
  Database,
  Pause,
  Play,
  RefreshCw,
  ShieldCheck,
  Square,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  setBearerToken,
  type Approval,
  type Attempt,
  type HistoryEvent,
  type JsonValue,
  type RunDetail,
  type RunSummary,
  type UsageRecord,
} from "./api.js";

function statusTone(status: string): string {
  if (["SUCCEEDED", "APPROVED"].includes(status)) return "success";
  if (["FAILED", "CANCELLED", "TIMED_OUT", "REJECTED", "EXPIRED"].includes(status)) return "danger";
  if (["WAITING_APPROVAL", "NEEDS_ATTENTION", "RETRY_WAIT", "PAUSED", "PAUSE_REQUESTED"].includes(status)) return "warning";
  if (["RUNNING", "QUEUED", "READY"].includes(status)) return "active";
  return "neutral";
}

function Status({ value }: { value: string }) {
  return <span className={`status status--${statusTone(value)}`}>{value.replaceAll("_", " ")}</span>;
}

function shortId(value: string): string {
  return value.slice(0, 8);
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).format(new Date(value));
}

function formatDuration(start: string, end: string | null): string {
  const milliseconds = Math.max(0, new Date(end ?? Date.now()).getTime() - new Date(start).getTime());
  if (milliseconds < 1_000) return `${milliseconds} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)} s`;
  return `${Math.floor(milliseconds / 60_000)}m ${Math.floor((milliseconds % 60_000) / 1_000)}s`;
}

function JsonPanel({ value, empty = "No output committed yet." }: { value: JsonValue | null; empty?: string }) {
  if (value === null) return <div className="empty-inline">{empty}</div>;
  return <pre className="json-panel">{JSON.stringify(value, null, 2)}</pre>;
}

function Metric({ label, value, detail }: { label: string; value: string | number; detail?: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
      {detail && <small>{detail}</small>}
    </div>
  );
}

function Operations({ principal, signOut }: { principal: { id: string; roles: string[] }; signOut: () => void }) {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [run, setRun] = useState<RunDetail | null>(null);
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [history, setHistory] = useState<HistoryEvent[]>([]);
  const [usage, setUsage] = useState<UsageRecord[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(() => {
    const match = window.location.pathname.match(/^\/runs\/([a-f0-9-]+)$/i);
    return match?.[1] ?? null;
  });
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [inspectTab, setInspectTab] = useState<"output" | "input" | "failure">("output");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadRuns = useCallback(async () => {
    const response = await api.listRuns();
    setRuns(response.runs);
    if (!selectedRunId && response.runs[0]) setSelectedRunId(response.runs[0].id);
  }, [selectedRunId]);

  const selectedRunRef = useRef(selectedRunId);
  selectedRunRef.current = selectedRunId;

  const loadDetail = useCallback(async (id: string) => {
    const [nextRun, nextAttempts, nextApprovals, nextHistory, nextUsage] = await Promise.all([
      api.getRun(id), api.getAttempts(id), api.getApprovals(id), api.getHistory(id), api.getUsage(id),
    ]);
    // A slow response for a previously selected run must not replace the current selection.
    if (selectedRunRef.current !== id) return;
    setRun(nextRun);
    setAttempts(nextAttempts.attempts);
    setApprovals(nextApprovals.approvals);
    setHistory(nextHistory.events);
    setUsage(nextUsage.usage);
    setSelectedStepId((current) => current && nextRun.steps.some((step) => step.id === current)
      ? current
      : nextRun.steps.at(-1)?.id ?? null);
  }, []);

  const refresh = useCallback(async (quiet = false) => {
    quiet ? setRefreshing(true) : setLoading(true);
    try {
      setError(null);
      await Promise.all([loadRuns(), ...(selectedRunId ? [loadDetail(selectedRunId)] : [])]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load AgentFlow data");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [loadDetail, loadRuns, selectedRunId]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!selectedRunId) return;
    window.history.replaceState(null, "", `/runs/${selectedRunId}`);
  }, [selectedRunId]);
  useEffect(() => {
    const timer = window.setInterval(() => void refresh(true), 1_500);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const selectedStep = useMemo(
    () => run?.steps.find((step) => step.id === selectedStepId) ?? null,
    [run, selectedStepId],
  );
  const selectedAttempts = attempts.filter((attempt) => attempt.stepId === selectedStepId);
  const pendingApprovals = approvals.filter((approval) => approval.status === "PENDING");
  const tokenTotals = usage.reduce((totals, record) => ({
    input: totals.input + (record.inputTokens ?? 0),
    output: totals.output + (record.outputTokens ?? 0),
  }), { input: 0, output: 0 });

  async function mutate(action: () => Promise<unknown>) {
    setMutating(true);
    try {
      setError(null);
      await action();
      await refresh(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Action failed");
    } finally {
      setMutating(false);
    }
  }

  function selectRun(id: string) {
    if (id === selectedRunId) return;
    setSelectedRunId(id);
    setSelectedStepId(null);
    setRun(null);
    setLoading(true);
  }

  async function decide(approval: Approval, decision: "APPROVE" | "REJECT") {
    await mutate(() => api.decideApproval(approval, decision));
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="AgentFlow operations home">
          <span className="brand-mark"><Activity size={18} strokeWidth={2.4} /></span>
          <span>AgentFlow</span>
          <span className="brand-area">Operations</span>
        </a>
        <div className="topbar-actions">
          <span className="connection">{principal.id}</span><button className="button" onClick={signOut}>Sign out</button>
          <button className="icon-button" onClick={() => void refresh(true)} disabled={refreshing} aria-label="Refresh run data">
            <RefreshCw size={17} className={refreshing ? "spin" : ""} />
          </button>
        </div>
      </header>

      <aside className="run-rail" aria-label="Workflow runs">
        <div className="rail-heading">
          <div><span className="eyebrow">Workspace</span><h1>Runs</h1></div>
          <span className="count">{runs.length}</span>
        </div>
        <div className="run-list">
          {runs.map((item) => (
            <button
              key={item.id}
              className={`run-item ${item.id === selectedRunId ? "run-item--selected" : ""}`}
              onClick={() => selectRun(item.id)}
              aria-current={item.id === selectedRunId ? "page" : undefined}
            >
              <span className="run-item-top"><strong>{item.workflowName}</strong><ChevronRight size={15} /></span>
              <span className="run-item-meta"><code>{shortId(item.id)}</code><Status value={item.publicStatus} /></span>
              <span className="run-item-bottom">{formatDate(item.createdAt)} · {item.completedStepCount}/{item.stepCount} steps</span>
            </button>
          ))}
          {!loading && runs.length === 0 && <div className="empty-rail">No runs yet. Create one through the API.</div>}
        </div>
      </aside>

      <main className="main-content">
        {error && <div className="error-banner" role="alert"><X size={17} />{error}</div>}
        {loading && !run ? (
          <div className="loading-state"><RefreshCw className="spin" /> Loading operations…</div>
        ) : !run ? (
          <div className="blank-state"><Database size={28} /><h2>No run selected</h2><p>Run activity will appear here.</p></div>
        ) : (
          <>
            <section className="run-header" aria-labelledby="run-title">
              <div>
                <div className="title-row"><span className="eyebrow">Run {shortId(run.id)}</span><Status value={run.publicStatus} /></div>
                <h2 id="run-title">{runs.find((item) => item.id === run.id)?.workflowName ?? "Workflow run"}</h2>
                <p className="run-identity"><code>{run.id}</code> · revision {run.stateRevision}</p>
              </div>
              <div className="control-group" aria-label="Run controls">
                {run.lifecycle === "OPEN" && run.control === "RUN" && (
                  <button className="button button--secondary" disabled={mutating} onClick={() => void mutate(() => api.controlRun(run.id, "pause"))}><Pause size={16} /> Pause</button>
                )}
                {run.lifecycle === "OPEN" && run.control === "PAUSED" && (
                  <button className="button button--primary" disabled={mutating} onClick={() => void mutate(() => api.controlRun(run.id, "resume"))}><Play size={16} /> Resume</button>
                )}
                {run.lifecycle === "OPEN" && (
                  <button className="button button--danger" disabled={mutating || run.control === "CANCEL_REQUESTED"} onClick={() => {
                    if (window.confirm("Cancel this run? This action cannot be resumed.")) void mutate(() => api.controlRun(run.id, "cancel"));
                  }}><Square size={15} /> Cancel</button>
                )}
              </div>
            </section>

            <section className="metrics" aria-label="Run summary">
              <Metric label="Progress" value={`${run.steps.filter((step) => step.status === "SUCCEEDED").length}/${run.steps.length}`} detail="committed steps" />
              <Metric label="Attempts" value={attempts.length} detail={`${attempts.filter((item) => item.status === "FAILED").length} failed · ${attempts.filter((item) => item.status === "ABANDONED").length} abandoned`} />
              <Metric label="Tokens" value={(tokenTotals.input + tokenTotals.output).toLocaleString()} detail={`${tokenTotals.input.toLocaleString()} in · ${tokenTotals.output.toLocaleString()} out`} />
              <Metric label="Elapsed" value={formatDuration(run.createdAt, run.finishedAt)} detail={`deadline ${formatDate(run.deadlineAt)}`} />
            </section>

            {pendingApprovals.length > 0 && (
              <section className="panel approval-panel" aria-labelledby="approval-title">
                <div className="panel-heading"><div><span className="eyebrow">Human checkpoint</span><h3 id="approval-title">Approval required</h3></div><ShieldCheck size={21} /></div>
                {pendingApprovals.map((approval) => (
                  <div className="approval-grid" key={approval.id}>
                    <div>
                      <p>Review the exact persisted proposal before continuing this run.</p>
                      <dl className="detail-list"><div><dt>Required role</dt><dd>{approval.reviewerRole}</dd></div><div><dt>Expires</dt><dd>{formatDate(approval.expiresAt)}</dd></div><div><dt>Payload hash</dt><dd><code>{approval.payloadHash.slice(0, 16)}…</code></dd></div></dl>
                      <JsonPanel value={approval.proposal} />
                    </div>
                    <div className="approval-form">
                      <p>Reviewing as {principal.id}</p>
                      {!principal.roles.includes(approval.reviewerRole) && (
                        <p role="note">Your credential lacks the <code>{approval.reviewerRole}</code> role required to decide.</p>
                      )}
                      <div className="approval-actions">
                        <button className="button button--danger" disabled={mutating || !principal.roles.includes(approval.reviewerRole)} onClick={() => void decide(approval, "REJECT")}><X size={16} /> Reject</button>
                        <button className="button button--primary" disabled={mutating || !principal.roles.includes(approval.reviewerRole)} onClick={() => void decide(approval, "APPROVE")}><Check size={16} /> Approve</button>
                      </div>
                    </div>
                  </div>
                ))}
              </section>
            )}

            <section className="panel" aria-labelledby="steps-title">
              <div className="panel-heading"><div><span className="eyebrow">Execution</span><h3 id="steps-title">Steps</h3></div><span className="panel-note">Select a step to inspect</span></div>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>#</th><th>Step</th><th>Kind</th><th>Status</th><th>Attempts</th><th>Duration</th><th><span className="sr-only">Inspect</span></th></tr></thead>
                  <tbody>{run.steps.map((step) => (
                    <tr key={step.id} className={step.id === selectedStepId ? "row-selected" : ""}>
                      <td>{String(step.position + 1).padStart(2, "0")}</td>
                      <td><button className="step-link" onClick={() => setSelectedStepId(step.id)}>{step.nodeKey}<small>{step.handler}</small></button></td>
                      <td>{step.kind}</td><td><Status value={step.status} /></td><td>{step.attemptCount}/{step.maxAttempts}</td>
                      <td>{formatDuration(step.createdAt, step.completedAt)}</td>
                      <td><button className="icon-button icon-button--small" onClick={() => setSelectedStepId(step.id)} aria-label={`Inspect ${step.nodeKey}`}><ChevronRight size={16} /></button></td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            </section>

            {selectedStep && (
              <section className="inspection-grid" aria-label={`Inspection for ${selectedStep.nodeKey}`}>
                <div className="panel">
                  <div className="panel-heading"><div><span className="eyebrow">Step inspection</span><h3>{selectedStep.nodeKey}</h3></div><Status value={selectedStep.status} /></div>
                  <div className="tabs" role="tablist" aria-label="Step data">
                    {(["output", "input", "failure"] as const).map((tab) => <button key={tab} role="tab" aria-selected={inspectTab === tab} onClick={() => setInspectTab(tab)}>{tab}</button>)}
                  </div>
                  <JsonPanel value={inspectTab === "output" ? selectedStep.acceptedOutput : inspectTab === "input" ? selectedStep.input : selectedStep.failure} empty={`No ${inspectTab} recorded.`} />
                </div>
                <div className="panel">
                  <div className="panel-heading"><div><span className="eyebrow">Physical execution</span><h3>Attempts</h3></div><span className="count">{selectedAttempts.length}</span></div>
                  <div className="attempt-list">
                    {selectedAttempts.map((attempt) => <AttemptCard key={attempt.id} attempt={attempt} />)}
                    {selectedAttempts.length === 0 && <div className="empty-inline">This step has no worker attempts.</div>}
                  </div>
                </div>
              </section>
            )}

            <section className="panel" aria-labelledby="history-title">
              <div className="panel-heading"><div><span className="eyebrow">Durable audit log</span><h3 id="history-title">History</h3></div><span className="panel-note">{history.length} events</span></div>
              <ol className="timeline">
                {history.slice().reverse().map((event) => (
                  <li key={event.id}><span className="timeline-dot" /><div><div className="timeline-head"><strong>{event.type.replaceAll("_", " ")}</strong><time>{formatDate(event.createdAt)}</time></div><span>Sequence {event.sequence}{event.attemptId ? ` · attempt ${shortId(event.attemptId)}` : ""}</span></div></li>
                ))}
              </ol>
            </section>
          </>
        )}
      </main>
    </div>
  );
}

function AttemptCard({ attempt }: { attempt: Attempt }) {
  return (
    <details className="attempt-card">
      <summary><span><strong>Attempt {attempt.attemptNo}</strong><small>{attempt.workerId}</small></span><Status value={attempt.status} /></summary>
      <dl className="detail-list"><div><dt>Started</dt><dd>{formatDate(attempt.startedAt)}</dd></div><div><dt>Duration</dt><dd>{formatDuration(attempt.startedAt, attempt.finishedAt)}</dd></div><div><dt>Lease epoch</dt><dd>{attempt.epoch}</dd></div><div><dt>Retryable</dt><dd>{attempt.retryable === null ? "—" : String(attempt.retryable)}</dd></div></dl>
      {attempt.error && <JsonPanel value={attempt.error} />}
    </details>
  );
}

export function App() {
  const [token, setToken] = useState("");
  const [principal, setPrincipal] = useState<{ id: string; roles: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (principal) return <Operations principal={principal} signOut={() => { setBearerToken(""); setPrincipal(null); }} />;
  return (
    <main className="auth-shell">
      <section className="panel auth-panel">
        <div className="auth-header">
          <div className="brand-mark" style={{ width: 42, height: 42, borderRadius: 10 }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
            </svg>
          </div>
          <h1>Sign in to AgentFlow</h1>
        </div>
        <form className="auth-form" onSubmit={(event) => {
          event.preventDefault(); setBusy(true); setError(null); setBearerToken(token);
          void api.me().then((identity) => { setPrincipal(identity); setToken(""); })
            .catch(() => { setBearerToken(""); setError("Sign-in failed. Check your access token and API connection."); })
            .finally(() => setBusy(false));
        }}>
          <div>
            <label htmlFor="access-token">Access token</label>
            <input id="access-token" type="password" autoComplete="current-password" required value={token}
              onChange={(event) => setToken(event.target.value)} aria-describedby="sign-in-help" style={{ marginTop: 8 }} />
          </div>
          <p id="sign-in-help">Use the access token provisioned by your administrator. It is kept only in memory.</p>
          {error && <p role="alert">{error}</p>}
          <button className="button button--primary" disabled={busy} style={{ width: "100%", marginTop: 8, height: 44, fontSize: 15 }}>
            {busy ? "Signing in..." : "Sign in"}
          </button>
        </form>
      </section>
    </main>
  );
}
