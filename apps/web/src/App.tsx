import {
  Check,
  ChevronRight,
  Eye,
  EyeOff,
  Inbox,
  Lock,
  LogOut,
  Pause,
  Play,
  Plus,
  RefreshCw,
  ShieldCheck,
  Square,
  User,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  api,
  type Approval,
  type Attempt,
  type HistoryEvent,
  type JsonValue,
  type RunDetail,
  type RunSummary,
  type UsageRecord,
} from "./api.js";
import { NewRunDrawer } from "./NewRunDrawer.js";
import { summarizeUsage, usageDetail } from "./new-run.js";
import { ModeBadge, ResultPanel } from "./ResultPanel.js";
import {
  BrandMark,
  Button,
  ConfirmDialog,
  EmptyState,
  IconButton,
  InlineAlert,
  Panel,
  ProgressBar,
  Skeleton,
  StatusBadge,
  Tabs,
  humanize,
  statusTone,
} from "./ui.js";

type Principal = { id: string; roles: string[]; username?: string };

function shortId(value: string): string {
  return value.slice(0, 8);
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).format(new Date(value));
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .format(new Date(value));
}

function formatRelative(value: string, now: number): string {
  const seconds = Math.round((now - new Date(value).getTime()) / 1_000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return formatDate(value);
}

function formatDuration(start: string, end: string | null): string {
  const milliseconds = Math.max(0, new Date(end ?? Date.now()).getTime() - new Date(start).getTime());
  if (milliseconds < 1_000) return `${milliseconds} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)} s`;
  return `${Math.floor(milliseconds / 60_000)}m ${Math.floor((milliseconds % 60_000) / 1_000)}s`;
}

function JsonPanel({ value, empty = "No output committed yet." }: { value: JsonValue | null; empty?: string }) {
  if (value === null) return <div className="empty-inline">{empty}</div>;
  return <pre className="code-block" tabIndex={0}>{JSON.stringify(value, null, 2)}</pre>;
}

function Stat({ label, value, detail }: { label: string; value: string | number; detail?: string }) {
  return (
    <div className="stat">
      <dt>{label}</dt>
      <dd>
        <span className="stat-value">{value}</span>
        {detail && <span className="stat-detail">{detail}</span>}
      </dd>
    </div>
  );
}

function historyTone(type: string): string {
  // Lease expiry is a recovery signal, not a terminal failure.
  if (/UNKNOWN|LEASE|RETRY|ABANDON|CANCEL|PAUSE/.test(type)) return "warning";
  if (/FAILED|EXPIRED|TIMED_OUT|REJECTED/.test(type)) return "danger";
  if (/SUCCEEDED|APPROVED|RESUMED/.test(type)) return "success";
  return "neutral";
}

function RunListSkeleton() {
  return (
    <div className="run-list" aria-hidden="true">
      {Array.from({ length: 6 }, (_, index) => (
        <div className="run-item run-item--skeleton" key={index}>
          <Skeleton width="70%" height={12} />
          <Skeleton width="45%" height={10} />
          <Skeleton width="100%" height={4} />
        </div>
      ))}
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="detail-skeleton" aria-label="Loading run" role="status">
      <Skeleton width="36%" height={20} />
      <Skeleton width="58%" height={12} />
      <div className="stats stats--skeleton">{Array.from({ length: 4 }, (_, index) => <Skeleton key={index} height={44} />)}</div>
      <Skeleton height={220} />
    </div>
  );
}

function Operations({ principal, signOut, onSessionExpired }: { principal: Principal; signOut: () => void; onSessionExpired?: () => void }) {
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
  const [runsLoaded, setRunsLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [newRunOpen, setNewRunOpen] = useState(false);
  const loadRuns = useCallback(async () => {
    const response = await api.listRuns();
    setRuns(response.runs);
    setRunsLoaded(true);
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
      setLastUpdated(Date.now());
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        if (onSessionExpired) onSessionExpired();
        else signOut();
        return;
      }
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
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const selectedStep = useMemo(
    () => run?.steps.find((step) => step.id === selectedStepId) ?? null,
    [run, selectedStepId],
  );
  const stepKeys = useMemo(
    () => new Map((run?.steps ?? []).map((step) => [step.id, step.nodeKey])),
    [run],
  );
  // Model names shown on AGENT steps come from persisted usage records only.
  const stepModels = useMemo(() => {
    const byStep = new Map<string, Set<string>>();
    for (const record of usage) byStep.set(record.stepId, (byStep.get(record.stepId) ?? new Set()).add(record.model));
    return new Map([...byStep].map(([stepId, models]) => [stepId, [...models].join(", ")]));
  }, [usage]);
  const selectedAttempts = attempts.filter((attempt) => attempt.stepId === selectedStepId);
  const pendingApprovals = approvals.filter((approval) => approval.status === "PENDING");
  // Token figures come only from persisted usage records; provenance is shown as returned.
  const usageSummary = useMemo(() => summarizeUsage(usage), [usage]);
  const runSummary = run ? runs.find((item) => item.id === run.id) : undefined;
  const committedSteps = run?.steps.filter((step) => step.status === "SUCCEEDED").length ?? 0;
  const materializedSteps = run?.steps.length ?? 0;
  const failedAttempts = attempts.filter((item) => item.status === "FAILED").length;
  const abandonedAttempts = attempts.filter((item) => item.status === "ABANDONED").length;
  const stale = error !== null && lastUpdated !== null;

  async function mutate(action: () => Promise<unknown>) {
    setMutating(true);
    try {
      setError(null);
      await action();
      await refresh(true);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        if (onSessionExpired) onSessionExpired();
        else signOut();
        return;
      }
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
          <BrandMark size={24} />
          <span className="brand-name">AgentFlow</span>
          <span className="brand-divider" aria-hidden="true">/</span>
          <span className="brand-area">Operations</span>
        </a>
        <div className="topbar-actions">
          <span className={`live-indicator ${stale ? "live-indicator--stale" : ""}`} role="status" aria-live="polite">
            <span className="live-dot" aria-hidden="true" />
            {stale ? "Connection lost" : lastUpdated ? `Live · updated ${formatRelative(new Date(lastUpdated).toISOString(), now)}` : "Connecting…"}
          </span>
          <IconButton label="Refresh now" onClick={() => void refresh(true)} disabled={refreshing}>
            <RefreshCw size={15} className={refreshing ? "spin" : ""} />
          </IconButton>
          <span className="topbar-separator" aria-hidden="true" />
          <span className="principal" title={principal.roles.length ? `Roles: ${principal.roles.join(", ")}` : "No roles"}>
            <span className="principal-avatar" aria-hidden="true">{(principal.username ?? principal.id).charAt(0).toUpperCase()}</span>
            <span className="principal-id">{principal.username ?? principal.id}</span>
          </span>
          <Button variant="ghost" size="sm" onClick={signOut} icon={<LogOut size={14} />}>Sign out</Button>
        </div>
      </header>

      <NewRunDrawer
        open={newRunOpen}
        onClose={() => setNewRunOpen(false)}
        onStarted={(id) => { selectRun(id); void refresh(true); }}
        onSessionExpired={() => (onSessionExpired ? onSessionExpired() : signOut())}
      />

      <aside className="run-rail" aria-label="Workflow runs">
        <div className="rail-header">
          <h1>Runs</h1>
          <div className="rail-header-actions">
            <span className="count" aria-label={`${runs.length} runs`}>{runs.length}</span>
            <Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={() => setNewRunOpen(true)}>New run</Button>
          </div>
        </div>
        {!runsLoaded && error ? (
          <div className="rail-message">
            <InlineAlert action={<Button size="sm" onClick={() => void refresh()}>Retry</Button>}>Runs could not be loaded.</InlineAlert>
          </div>
        ) : !runsLoaded ? (
          <RunListSkeleton />
        ) : runs.length === 0 ? (
          <EmptyState icon={<Inbox size={20} />} title="No runs yet">
            <p>Start a scripted or live Gemini run from here, or create one through the API or CLI.</p>
            <Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={() => setNewRunOpen(true)}>Start your first run</Button>
          </EmptyState>
        ) : (
          <nav className="run-list">
            {runs.map((item) => (
              <button
                key={item.id}
                className={`run-item ${item.id === selectedRunId ? "run-item--selected" : ""}`}
                onClick={() => selectRun(item.id)}
                aria-current={item.id === selectedRunId ? "page" : undefined}
              >
                <span className="run-item-row">
                  <span className="run-item-name" title={item.workflowName}>{item.workflowName}</span>
                  <ModeBadge providers={item.providers} size="sm" />
                  <StatusBadge value={item.publicStatus} size="sm" />
                </span>
                <span className="run-item-row run-item-meta">
                  <code>{shortId(item.id)}</code>
                  <time dateTime={item.createdAt} title={formatDate(item.createdAt)}>{formatRelative(item.createdAt, now)}</time>
                </span>
                <span className="run-item-row run-item-progress">
                  <ProgressBar value={item.completedStepCount} total={item.stepCount} label={`${item.workflowName} progress`} />
                  <span>{item.completedStepCount}/{item.stepCount}</span>
                </span>
              </button>
            ))}
          </nav>
        )}
      </aside>

      <main className="main-content">
        {error && (
          <InlineAlert action={<Button size="sm" onClick={() => void refresh(true)}>Retry</Button>}>
            {stale ? `Showing data from ${formatTime(new Date(lastUpdated!).toISOString())}. ` : ""}{error}
          </InlineAlert>
        )}
        {loading && !run ? (
          <DetailSkeleton />
        ) : !run ? (
          <EmptyState icon={<Inbox size={22} />} title="No run selected">Select a run to inspect its steps, attempts, and history.</EmptyState>
        ) : (
          <>
            <section className="run-header" aria-labelledby="run-title">
              <div className="run-header-main">
                <nav className="breadcrumb" aria-label="Breadcrumb"><span>Runs</span><ChevronRight size={12} aria-hidden="true" /><code>{shortId(run.id)}</code></nav>
                <div className="run-title-row">
                  <h2 id="run-title" title={runSummary?.workflowName}>{runSummary?.workflowName ?? "Workflow run"}</h2>
                  <ModeBadge providers={run.providers ?? runSummary?.providers} />
                  <StatusBadge value={run.publicStatus} />
                </div>
                <dl className="run-meta">
                  <div><dt>Run ID</dt><dd><code>{run.id}</code></dd></div>
                  <div><dt>Created</dt><dd>{formatDate(run.createdAt)}</dd></div>
                  <div><dt>{run.finishedAt ? "Finished" : "Deadline"}</dt><dd>{formatDate(run.finishedAt ?? run.deadlineAt)}</dd></div>
                  <div><dt>Revision</dt><dd>{run.stateRevision}</dd></div>
                </dl>
              </div>
              <div className="run-controls" aria-label="Run controls">
                {run.lifecycle === "OPEN" && run.control === "RUN" && (
                  <Button disabled={mutating} onClick={() => void mutate(() => api.controlRun(run.id, "pause"))} icon={<Pause size={14} />}>Pause</Button>
                )}
                {run.lifecycle === "OPEN" && run.control === "PAUSED" && (
                  <Button variant="primary" disabled={mutating} onClick={() => void mutate(() => api.controlRun(run.id, "resume"))} icon={<Play size={14} />}>Resume</Button>
                )}
                {run.lifecycle === "OPEN" && (
                  <Button variant="danger" disabled={mutating || run.control === "CANCEL_REQUESTED"} onClick={() => setConfirmCancel(true)} icon={<Square size={13} />}>Cancel run</Button>
                )}
              </div>
            </section>

            <div className="run-progress">
              <ProgressBar value={committedSteps} total={materializedSteps} label="Committed steps" tone={statusTone(run.publicStatus)} />
              <span>{committedSteps} committed · {materializedSteps} materialized</span>
            </div>

            <dl className="stats" aria-label="Run summary">
              <Stat label="Committed steps" value={`${committedSteps}/${materializedSteps}`} detail="of materialized steps" />
              <Stat label="Attempts" value={attempts.length} detail={`${failedAttempts} failed · ${abandonedAttempts} abandoned`} />
              <Stat label="Tokens" value={usageSummary ? (usageSummary.input + usageSummary.output).toLocaleString() : "—"}
                detail={usageDetail(usageSummary)} />
              <Stat label="Elapsed" value={formatDuration(run.createdAt, run.finishedAt)} detail={run.finishedAt ? "completed" : "in progress"} />
            </dl>

            {pendingApprovals.length > 0 && (
              <Panel title="Approval required" meta="Human checkpoint" tone="warning" actions={<ShieldCheck size={16} aria-hidden="true" />}>
                {pendingApprovals.map((approval) => {
                  const canDecide = principal.roles.includes(approval.reviewerRole);
                  return (
                    <div className="approval" key={approval.id}>
                      <div className="approval-proposal">
                        <p className="approval-lead">Review the exact persisted proposal. Your decision is bound to its payload hash.</p>
                        <dl className="kv">
                          <div><dt>Required role</dt><dd><code>{approval.reviewerRole}</code></dd></div>
                          <div><dt>Expires</dt><dd>{formatDate(approval.expiresAt)}</dd></div>
                          <div><dt>Payload hash</dt><dd><code title={approval.payloadHash}>{approval.payloadHash.slice(0, 16)}…</code></dd></div>
                        </dl>
                        <JsonPanel value={approval.proposal} />
                      </div>
                      <div className="approval-decision">
                        <span className="approval-reviewer">Reviewing as <strong>{principal.id}</strong></span>
                        {!canDecide && (
                          <p className="approval-note" role="note">Your credential lacks the <code>{approval.reviewerRole}</code> role required to decide.</p>
                        )}
                        <div className="approval-actions">
                          <Button variant="danger" disabled={mutating || !canDecide} onClick={() => void decide(approval, "REJECT")} icon={<X size={14} />}>Reject</Button>
                          <Button variant="primary" loading={mutating} disabled={!canDecide} onClick={() => void decide(approval, "APPROVE")} icon={<Check size={14} />}>Approve</Button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </Panel>
            )}

            <ResultPanel run={run} usage={usage} />

            <Panel title="Steps" meta="Materialized as the run advances" labelledBy="steps-title">
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th className="col-index">#</th><th>Step</th><th className="col-kind">Kind</th><th>Status</th><th className="col-num">Attempts</th><th className="col-num col-duration">Duration</th></tr></thead>
                  <tbody>{run.steps.map((step) => (
                    <tr key={step.id} className={step.id === selectedStepId ? "is-selected" : ""} onClick={() => setSelectedStepId(step.id)}>
                      <td className="col-index">{String(step.position + 1).padStart(2, "0")}</td>
                      <td>
                        <button className="step-link" onClick={(event) => { event.stopPropagation(); setSelectedStepId(step.id); }}
                          aria-pressed={step.id === selectedStepId}>
                          <span>{step.nodeKey}</span><code>{step.handler}</code>
                          {stepModels.get(step.id) && <span className="step-model" title="Model from persisted usage records">{stepModels.get(step.id)}</span>}
                        </button>
                      </td>
                      <td className="col-kind"><span className="tag">{humanize(step.kind)}</span></td>
                      <td><StatusBadge value={step.status} size="sm" /></td>
                      <td className="col-num">{step.attemptCount}/{step.maxAttempts}</td>
                      <td className="col-num col-duration">{formatDuration(step.createdAt, step.completedAt ?? run.finishedAt)}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            </Panel>

            {selectedStep && (
              <section className="inspection" aria-label={`Inspection for ${selectedStep.nodeKey}`}>
                <Panel title={selectedStep.nodeKey} meta="Step data" actions={<StatusBadge value={selectedStep.status} size="sm" />}>
                  <Tabs tabs={["output", "input", "failure"] as const} value={inspectTab} onChange={setInspectTab} label="Step data" idPrefix="step-data" />
                  <div id="step-data-panel" role="tabpanel" aria-labelledby={`step-data-tab-${inspectTab}`}>
                    <JsonPanel value={inspectTab === "output" ? selectedStep.acceptedOutput : inspectTab === "input" ? selectedStep.input : selectedStep.failure} empty={`No ${inspectTab} recorded.`} />
                  </div>
                </Panel>
                <Panel title="Attempts" meta={`${selectedAttempts.length} for this step`}>
                  <div className="attempt-list">
                    {selectedAttempts.map((attempt) => <AttemptRow key={attempt.id} attempt={attempt} />)}
                    {selectedAttempts.length === 0 && <div className="empty-inline">This step has no worker attempts.</div>}
                  </div>
                </Panel>
              </section>
            )}

            <Panel title="History" meta={`${history.length} durable events`} labelledBy="history-title">
              {history.length === 0 ? <div className="empty-inline">No events recorded.</div> : (
                <ol className="history">
                  {history.slice().reverse().map((event) => (
                    <li key={event.id} className={`history-row history-row--${historyTone(event.type)}`}>
                      <span className="history-seq">#{event.sequence}</span>
                      <time dateTime={event.createdAt} title={formatDate(event.createdAt)}>{formatTime(event.createdAt)}</time>
                      <span className="history-type"><span className="history-dot" aria-hidden="true" />{humanize(event.type)}</span>
                      <span className="history-context">
                        {event.stepId && stepKeys.get(event.stepId) && <code>{stepKeys.get(event.stepId)}</code>}
                        {event.attemptId && <span>attempt {shortId(event.attemptId)}</span>}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </Panel>

            <ConfirmDialog
              open={confirmCancel}
              title="Cancel this run?"
              confirmLabel="Cancel run"
              dismissLabel="Keep running"
              onClose={() => setConfirmCancel(false)}
              onConfirm={() => void mutate(() => api.controlRun(run.id, "cancel"))}
            >
              Unfinished steps will be cancelled and the run cannot be resumed. Committed steps and receiver effects are kept.
            </ConfirmDialog>
          </>
        )}
      </main>
    </div>
  );
}

function AttemptRow({ attempt }: { attempt: Attempt }) {
  return (
    <details className="attempt">
      <summary>
        <ChevronRight size={14} className="attempt-chevron" aria-hidden="true" />
        <span className="attempt-title">Attempt {attempt.attemptNo}</span>
        <code className="attempt-worker" title={attempt.workerId}>{attempt.workerId}</code>
        <StatusBadge value={attempt.status} size="sm" />
      </summary>
      <dl className="kv kv--compact">
        <div><dt>Started</dt><dd>{formatDate(attempt.startedAt)}</dd></div>
        <div><dt>Duration</dt><dd>{formatDuration(attempt.startedAt, attempt.finishedAt)}</dd></div>
        <div><dt>Lease epoch</dt><dd>{attempt.epoch}</dd></div>
        <div><dt>Retryable</dt><dd>{attempt.retryable === null ? "—" : String(attempt.retryable)}</dd></div>
        {attempt.errorClass && <div><dt>Error class</dt><dd>{humanize(attempt.errorClass)}</dd></div>}
      </dl>
      {attempt.error && <JsonPanel value={attempt.error} />}
    </details>
  );
}

function signInError(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.status === 401) return "Invalid username or password. Check your credentials.";
    if (cause.status === 0 || cause.status >= 500) return "The AgentFlow API could not be reached. Check that it is running.";
    if (cause.status === 404) return "The server at the API address is not an AgentFlow API. Check that the AgentFlow API is running on the configured port.";
  }
  return "Sign-in failed. Check your credentials and API connection.";
}

export function App() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [principal, setPrincipal] = useState<Principal | null>(null);
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    api.me()
      .then((identity) => {
        if (active) setPrincipal(identity);
      })
      .catch(() => {
        if (active) setPrincipal(null);
      })
      .finally(() => {
        if (active) setCheckingAuth(false);
      });
    return () => { active = false; };
  }, []);

  const handleSignOut = useCallback(() => {
    void api.logout().finally(() => {
      setPrincipal(null);
      setError(null);
    });
  }, []);

  const handleSessionExpired = useCallback(() => {
    setPrincipal(null);
    setError("Your session has expired. Please sign in again.");
  }, []);

  if (checkingAuth) {
    return (
      <main className="auth-shell">
        <div className="auth-container" style={{ textAlign: "center" }}>
          <BrandMark size={32} />
          <p style={{ color: "var(--text-tertiary)", fontSize: "var(--text-sm)", marginTop: "var(--space-3)" }}>
            Checking session…
          </p>
        </div>
      </main>
    );
  }

  if (principal) {
    return <Operations principal={principal} signOut={handleSignOut} onSessionExpired={handleSessionExpired} />;
  }

  return (
    <main className="auth-shell">
      <div className="auth-container">
        <div className="auth-brand"><BrandMark size={28} /><span>AgentFlow</span></div>
        <section className="auth-card" aria-labelledby="sign-in-title">
          <header className="auth-header">
            <h1 id="sign-in-title">Sign in to Operations</h1>
            <p>Inspect, control, and approve durable agent workflow runs.</p>
          </header>
          <form className="auth-form" noValidate={false} onSubmit={(event) => {
            event.preventDefault();
            setBusy(true);
            setError(null);
            api.login(username, password)
              .then((result) => {
                setPrincipal(result.user);
                setPassword("");
              })
              .catch((cause: unknown) => {
                setError(signInError(cause));
              })
              .finally(() => setBusy(false));
          }}>
            <div className="field">
              <label htmlFor="username">Username</label>
              <div className={`input-group ${error ? "input-group--invalid" : ""}`}>
                <User size={15} className="input-icon" aria-hidden="true" />
                <input
                  id="username"
                  type="text"
                  autoComplete="username"
                  required
                  spellCheck={false}
                  autoCapitalize="off"
                  value={username}
                  disabled={busy}
                  placeholder="Username"
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? "sign-in-error" : undefined}
                  onChange={(event) => setUsername(event.target.value)}
                />
              </div>
            </div>
            <div className="field">
              <label htmlFor="password">Password</label>
              <div className={`input-group ${error ? "input-group--invalid" : ""}`}>
                <Lock size={15} className="input-icon" aria-hidden="true" />
                <input
                  id="password"
                  type={revealed ? "text" : "password"}
                  autoComplete="current-password"
                  required
                  spellCheck={false}
                  autoCapitalize="off"
                  value={password}
                  disabled={busy}
                  placeholder="Password"
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? "sign-in-error" : undefined}
                  onChange={(event) => setPassword(event.target.value)}
                />
                <IconButton
                  type="button"
                  label={revealed ? "Hide password" : "Show password"}
                  className="input-action"
                  onClick={() => setRevealed((value) => !value)}
                >
                  {revealed ? <EyeOff size={15} /> : <Eye size={15} />}
                </IconButton>
              </div>
            </div>
            {error && <div id="sign-in-error"><InlineAlert>{error}</InlineAlert></div>}
            <Button
              type="submit"
              variant="primary"
              size="lg"
              loading={busy}
              disabled={username.trim().length === 0 || password.length === 0}
            >
              {busy ? "Signing in…" : "Sign in"}
            </Button>
          </form>
        </section>
        <p className="auth-footnote">Credentials are authenticated via secure HTTP-only session cookies.</p>
      </div>
    </main>
  );
}
