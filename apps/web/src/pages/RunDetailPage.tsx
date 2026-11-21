import { History as HistoryIcon, Pause, Play, RotateCcw, ShieldCheck, Square, Wrench } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import {
  ApiError, api, type Approval, type Attempt, type HistoryEvent, type RunDetail, type ServerUsageSummary,
  type Step, type StepUsageSummary, type ToolExecution, type UsageRecord,
} from "../api.js";
import {
  Badge, Button, Card, CodeBlock, Dialog, EmptyState, ErrorState, IdChip, InlineAlert, KeyValue,
  Skeleton, StatusPill, TabPanel, Tabs, Tag, Timeline, Tooltip, statusTone, terminalStatuses, useToast,
} from "../design/index.js";
import { formatAbsolute, formatClock, formatCost, formatNumber, formatRelative, formatSpan, formatTokens, humanize, shortId } from "../lib/format.js";
import { deriveRecoveryEvents, historyTone } from "../lib/recovery.js";
import { errorMessage, useNow, usePolling, useSession } from "../lib/session.js";
import { ApprovalCard } from "../components/ApprovalCard.js";
import { ReconcileAction } from "../components/ReconcileAction.js";
import { ResultPanel } from "../ResultPanel.js";
import { useBreadcrumbs } from "../shell/AppShell.js";
import { LiveIndicator, ProviderBadge, stepType } from "./common.js";

interface RunBundle {
  run: RunDetail;
  attempts: Attempt[];
  approvals: Approval[];
  history: HistoryEvent[];
  usage: UsageRecord[];
  summary: ServerUsageSummary | null;
  tools: ToolExecution[];
}

async function loadRun(id: string): Promise<RunBundle> {
  const [run, attempts, approvals, history, usage, tools] = await Promise.all([
    api.getRun(id), api.getAttempts(id), api.getApprovals(id), api.getHistory(id), api.getUsage(id), api.getToolExecutions(id),
  ]);
  return {
    run, attempts: attempts.attempts, approvals: approvals.approvals, history: history.events,
    usage: usage.usage, summary: usage.summary ?? null, tools: tools.executions,
  };
}

const inspectorTabs = ["input", "output", "attempts", "usage", "tools", "raw"] as const;
type InspectorTab = (typeof inspectorTabs)[number];

function stepTokens(summary: StepUsageSummary | undefined): number | null {
  if (!summary || summary.billedCalls === 0) return null;
  return summary.billedInputTokens + summary.billedOutputTokens;
}

/* ------------------------------------------------------------- Token panel */
function TokenPanel({ summary, usage }: { summary: ServerUsageSummary | null; usage: UsageRecord[] }) {
  const provenances = [...new Set(usage.map((record) => record.provenance))].sort();
  if (!summary || (summary.billedCalls ?? 0) + summary.replayedCalls + summary.cacheHitCalls === 0) {
    return <Card title="Tokens" meta="From persisted usage records"><p className="muted-inline">No LLM calls in this run yet.</p></Card>;
  }
  const billed = (summary.billedInputTokens ?? 0) + (summary.billedOutputTokens ?? 0);
  const replayed = summary.savedByReplayInputTokens + summary.savedByReplayOutputTokens;
  const cached = summary.savedByCacheInputTokens + summary.savedByCacheOutputTokens;
  const budget = summary.budget;
  return (
    <Card title="Tokens" meta={`Provenance: ${provenances.join(", ") || "—"}`}>
      <div className="token-grid">
        <div className="metric">
          <span className="metric-label">Billed</span>
          <span className="metric-value tabular">{formatNumber(billed)}</span>
          <span className="metric-detail tabular">{formatNumber(summary.billedInputTokens)} in · {formatNumber(summary.billedOutputTokens)} out · {summary.billedCalls ?? 0} calls</span>
        </div>
        <div className="metric">
          <span className="metric-label">Cached input</span>
          <span className="metric-value tabular">{formatNumber(summary.billedCachedInputTokens)}</span>
          <span className="metric-detail">Provider-side cache, part of billed input</span>
        </div>
        <div className={`metric ${replayed > 0 ? "metric--success" : ""}`}>
          <span className="metric-label">Saved by journal replay</span>
          <span className="metric-value tabular">{formatNumber(replayed)}</span>
          <span className="metric-detail tabular">{summary.replayedCalls} calls not repeated after recovery</span>
        </div>
        <div className={`metric ${cached > 0 ? "metric--success" : ""}`}>
          <span className="metric-label">Saved by response cache</span>
          <span className="metric-value tabular">{formatNumber(cached)}</span>
          <span className="metric-detail tabular">{summary.cacheLookups.hits} hits · {summary.cacheLookups.misses} misses · scope {summary.cacheScope ?? "run"}</span>
        </div>
      </div>
      {(summary.unreportedCalls ?? 0) > 0 && (
        <p className="metric-note">{summary.unreportedCalls} call(s) returned no usage from the provider; they are excluded, not estimated.</p>
      )}
      {budget && (
        <div className="budget-bar">
          <span className="metric-label">Budget</span>
          {budget.maxTokens !== null && (
            <span className="tabular">{formatNumber(budget.tokensUsed)} / {formatNumber(budget.maxTokens)} tokens</span>
          )}
          {budget.maxCostUsd !== null && (
            <span className="tabular">{formatCost(budget.costUsd)} / {formatCost(budget.maxCostUsd)}</span>
          )}
        </div>
      )}
    </Card>
  );
}

/* --------------------------------------------------------------- Inspector */
function StepInspector({
  step, tab, onTab, attempts, usage, stepSummary, tools, now, onChanged,
}: {
  step: Step;
  tab: InspectorTab;
  onTab: (tab: InspectorTab) => void;
  attempts: Attempt[];
  usage: UsageRecord[];
  stepSummary: StepUsageSummary | undefined;
  tools: ToolExecution[];
  now: number;
  onChanged: () => void;
}) {
  const type = stepType(step.kind);
  return (
    <aside className="inspector card" aria-label={`Step ${step.nodeKey}`}>
      <header className="inspector-header">
        <div className="inspector-title">
          <span className="inspector-icon" aria-hidden="true">{type.icon}</span>
          <h2>{step.nodeKey}</h2>
          <StatusPill value={step.status} size="sm" />
        </div>
        <div className="inspector-meta">
          <Tag>{type.label}</Tag>
          <code>{step.handler}</code>
          <span className="tabular">attempt {step.attemptCount}/{step.maxAttempts}</span>
          {step.leaseEpoch !== undefined && (
            <Tooltip content="Fencing epoch: completions from older epochs are rejected"><span className="tabular" tabIndex={0}>epoch {step.leaseEpoch}</span></Tooltip>
          )}
          {step.leaseOwner && (
            <Tooltip content={`Lease holder${step.leaseExpiresAt ? `, lease expires ${formatAbsolute(step.leaseExpiresAt)}` : ""}`}>
              <code tabIndex={0}>{step.leaseOwner}</code>
            </Tooltip>
          )}
          {step.completedAt && <span title={formatAbsolute(step.completedAt)}>checkpointed {formatRelative(step.completedAt, now)}</span>}
        </div>
      </header>
      <Tabs
        label="Step data"
        value={tab}
        onChange={onTab}
        tabs={[
          { value: "input", label: "Input" },
          { value: "output", label: "Output" },
          { value: "attempts", label: "Attempts", count: attempts.length },
          { value: "usage", label: "Usage" },
          { value: "tools", label: "Tools", count: tools.length },
          { value: "raw", label: "Raw" },
        ]}
      >
        <TabPanel value="input"><CodeBlock value={step.input} empty="No input recorded." /></TabPanel>
        <TabPanel value="output">
          {step.failure !== null && <div className="inspector-failure"><InlineAlert>Step failed</InlineAlert><CodeBlock value={step.failure} label="Failure" /></div>}
          <CodeBlock value={step.acceptedOutput} empty="No output committed yet." />
        </TabPanel>
        <TabPanel value="attempts">
          {attempts.length === 0 ? <p className="muted-inline">No worker attempts yet.</p> : (
            <ol className="attempts">
              {attempts.map((attempt) => (
                <li key={attempt.id} className="attempt">
                  <div className="attempt-row">
                    <strong>Attempt {attempt.attemptNo}</strong>
                    <StatusPill value={attempt.status} size="sm" />
                    <span className="attempt-time tabular" title={formatAbsolute(attempt.startedAt)}>{formatClock(attempt.startedAt)} · {formatSpan(attempt.startedAt, attempt.finishedAt, now)}</span>
                  </div>
                  <KeyValue columns={2} items={[
                    { label: "Worker", value: <code>{attempt.workerId}</code> },
                    { label: "Epoch", value: attempt.epoch },
                    { label: "Error class", value: attempt.errorClass ? humanize(attempt.errorClass) : "—" },
                    { label: "Retryable", value: attempt.retryable === null ? "—" : attempt.retryable ? "Yes" : "No" },
                  ]} />
                  {attempt.error !== null && <CodeBlock value={attempt.error} maxHeight={180} />}
                </li>
              ))}
            </ol>
          )}
        </TabPanel>
        <TabPanel value="usage">
          {usage.length === 0 && !stepSummary?.replayedCalls && !stepSummary?.cacheHitCalls ? <p className="muted-inline">This step made no LLM calls.</p> : (
            <>
              {stepSummary && (
                <KeyValue columns={2} items={[
                  { label: "Billed input", value: formatNumber(stepSummary.billedInputTokens) },
                  { label: "Billed output", value: formatNumber(stepSummary.billedOutputTokens) },
                  { label: "Cached input", value: formatNumber(stepSummary.billedCachedInputTokens) },
                  { label: "Reasoning", value: formatNumber(stepSummary.billedReasoningTokens) },
                  { label: "Journal replays", value: `${stepSummary.replayedCalls} · ${formatNumber(stepSummary.savedByReplayInputTokens + stepSummary.savedByReplayOutputTokens)} saved` },
                  { label: "Cache hits", value: `${stepSummary.cacheHitCalls} · ${formatNumber(stepSummary.savedByCacheInputTokens + stepSummary.savedByCacheOutputTokens)} saved` },
                ]} />
              )}
              <div className="table-wrap usage-table">
                <table className="table">
                  <thead><tr><th>Model</th><th>Provenance</th><th className="num">In</th><th className="num">Out</th><th className="num">Cached</th></tr></thead>
                  <tbody>{usage.map((record) => (
                    <tr key={record.id}>
                      <td><code>{record.model}</code></td>
                      <td><Badge tone={record.provenance === "reported" ? "success" : record.provenance === "estimated" ? "warning" : "neutral"}>{record.provenance}</Badge></td>
                      <td className="num">{formatNumber(record.inputTokens)}</td>
                      <td className="num">{formatNumber(record.outputTokens)}</td>
                      <td className="num">{formatNumber(record.cachedInputTokens)}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            </>
          )}
        </TabPanel>
        <TabPanel value="tools">
          {tools.length === 0 ? <p className="muted-inline">This step made no side-effecting tool calls.</p> : (
            <ol className="attempts">
              {tools.map((tool) => (
                <li key={tool.id} className="attempt">
                  <div className="attempt-row">
                    <strong>{tool.toolName}</strong>
                    <StatusPill value={tool.invocationStatus} size="sm" />
                    <Badge tone={tool.effectClass === "UNSAFE_WRITE" ? "warning" : "neutral"}>{humanize(tool.effectClass)}</Badge>
                  </div>
                  <KeyValue items={[
                    { label: "Receiver id", value: tool.receiverId ? <code>{tool.receiverId}</code> : "—" },
                    { label: "Idempotency key", value: <code title={tool.idempotencyKey}>{tool.idempotencyKey.slice(0, 28)}…</code> },
                    { label: "Request hash", value: <code title={tool.requestHash}>{tool.requestHash.slice(0, 16)}…</code> },
                    { label: "Sent", value: tool.sentAt ? formatAbsolute(tool.sentAt) : "—" },
                  ]} />
                  {tool.invocationStatus === "UNKNOWN" && <ReconcileAction tool={tool} onResolved={onChanged} />}
                  {tool.receipt !== null && <CodeBlock value={tool.receipt} label="Receipt" maxHeight={200} />}
                </li>
              ))}
            </ol>
          )}
        </TabPanel>
        <TabPanel value="raw"><CodeBlock value={step} /></TabPanel>
      </Tabs>
    </aside>
  );
}

/* -------------------------------------------------------------------- Page */
export function RunDetailPage() {
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const toast = useToast();
  const now = useNow();
  const bundle = usePolling(() => loadRun(id), [id], 1_500);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [mutating, setMutating] = useState(false);

  const data = bundle.data;
  const run = data?.run;
  useBreadcrumbs([{ label: "Runs", to: "/runs" }, { label: run?.workflowName ?? "Run" }, { label: <code>{shortId(id)}</code> }]);

  const selectedStep = useMemo(() => {
    if (!run) return null;
    const requested = params.get("step");
    return run.steps.find((step) => step.id === requested) ?? run.steps.find((step) => step.status === "RUNNING") ?? run.steps.at(-1) ?? null;
  }, [run, params]);
  const requestedTab = params.get("tab");
  const tab: InspectorTab = (inspectorTabs as readonly string[]).includes(requestedTab ?? "") ? requestedTab as InspectorTab : "output";
  const setUrl = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(patch)) next.set(key, value);
    setParams(next, { replace: true });
  };

  const recovery = useMemo(() => deriveRecoveryEvents(data?.history ?? []), [data?.history]);
  const stepModels = useMemo(() => {
    const models = new Map<string, Set<string>>();
    for (const record of data?.usage ?? []) models.set(record.stepId, (models.get(record.stepId) ?? new Set()).add(record.model));
    return models;
  }, [data?.usage]);

  if (bundle.error && !data) {
    const missing = bundle.error.includes("(404)");
    return (
      <div className="page">
        {missing
          ? <EmptyState title="Run not found" action={<Link to="/runs" className="btn btn--secondary btn--sm">Back to runs</Link>}>It may belong to another owner, or the ID is wrong.</EmptyState>
          : <ErrorState title="Run could not be loaded" message={bundle.error} onRetry={() => void bundle.refresh()} />}
      </div>
    );
  }
  if (!data || !run) {
    return (
      <div className="page" aria-busy="true" aria-label="Loading run">
        <Skeleton width="32%" height={24} />
        <Skeleton width="56%" height={12} />
        <div className="detail-grid"><Skeleton height={420} /><Skeleton height={420} /></div>
      </div>
    );
  }

  const pending = data.approvals.filter((approval) => approval.status === "PENDING");
  const unknownTool = data.tools.find((tool) => tool.invocationStatus === "UNKNOWN");
  const committed = run.steps.filter((step) => step.status === "SUCCEEDED").length;
  const summaryByStep = new Map((data.summary?.byStep ?? []).map((item) => [item.stepId, item]));

  async function control(command: "pause" | "resume" | "cancel") {
    setMutating(true);
    try {
      await api.controlRun(id, command);
      toast.show({ tone: "success", title: command === "cancel" ? "Cancellation requested" : command === "pause" ? "Pause requested" : "Run resumed" });
      await bundle.refresh();
    } catch (cause) {
      toast.show({ tone: "danger", title: "Action failed", description: cause instanceof ApiError ? cause.message : errorMessage(cause) });
    } finally {
      setMutating(false);
    }
  }

  return (
    <div className="page run-detail">
      <header className="run-header">
        <div className="run-header-main">
          <div className="run-title">
            <h1>{run.workflowName ?? "Workflow run"}</h1>
            <StatusPill value={run.publicStatus} />
            <ProviderBadge providers={run.providers} />
          </div>
          <div className="run-meta">
            <IdChip value={run.id} display={shortId(run.id)} />
            <span title={formatAbsolute(run.createdAt)}>Started {formatRelative(run.createdAt, now)}</span>
            <span className="tabular">{run.finishedAt ? "Took" : "Running for"} {formatSpan(run.createdAt, run.finishedAt, now)}</span>
            {!run.finishedAt && <span title={formatAbsolute(run.deadlineAt)}>Deadline {formatRelative(run.deadlineAt, now)}</span>}
            <span className="tabular">{committed}/{run.steps.length} steps committed</span>
            <span className="tabular">revision {run.stateRevision}</span>
            {(run.maxTokens || run.maxCostUsd) && (
              <span className="tabular">Budget {[run.maxTokens ? `${formatTokens(run.maxTokens)} tokens` : null, run.maxCostUsd ? formatCost(run.maxCostUsd) : null].filter(Boolean).join(" · ")}</span>
            )}
          </div>
        </div>
        <div className="run-actions">
          <LiveIndicator updatedAt={bundle.updatedAt} refreshing={bundle.refreshing} error={bundle.error} now={now} />
          {pending.length > 0 && <a className="btn btn--primary btn--md" href={`#approval-${pending[0]!.id}`}><ShieldCheck size={16} aria-hidden="true" /><span>Review approval</span></a>}
          {unknownTool && run.lifecycle === "OPEN" && (
            <Button variant="primary" icon={<Wrench size={16} />} onClick={() => setUrl({ step: unknownTool.stepId, tab: "tools" })}>Resolve unknown effect</Button>
          )}
          {run.lifecycle === "OPEN" && run.control === "RUN" && <Button icon={<Pause size={16} />} disabled={mutating} onClick={() => void control("pause")}>Pause</Button>}
          {run.lifecycle === "OPEN" && run.control === "PAUSED" && <Button variant="primary" icon={<Play size={16} />} disabled={mutating} onClick={() => void control("resume")}>Resume</Button>}
          {run.lifecycle === "OPEN" && (
            <Button variant="danger" icon={<Square size={16} />} disabled={mutating || run.control === "CANCEL_REQUESTED"} onClick={() => setConfirmCancel(true)}>Cancel</Button>
          )}
        </div>
      </header>

      {run.failure !== null && terminalStatuses.has(run.publicStatus) && run.publicStatus !== "SUCCEEDED" && (
        <InlineAlert>
          <strong>{humanize(run.publicStatus)}</strong>
          {typeof run.failure === "object" && run.failure && "code" in run.failure ? ` · ${String((run.failure as { code: unknown }).code)}` : ""}
        </InlineAlert>
      )}

      {recovery.length > 0 && (
        <section className="recovery" aria-labelledby="recovery-title">
          <h2 id="recovery-title" className="recovery-title"><RotateCcw size={16} aria-hidden="true" />Recovery events</h2>
          <ol className="recovery-list">
            {recovery.map((event) => {
              const step = run.steps.find((item) => item.id === event.stepId);
              return (
                <li key={event.id}>
                  <button type="button" className={`recovery-chip recovery-chip--${event.tone}`} disabled={!step}
                    onClick={() => step && setUrl({ step: step.id })} title={event.description}>
                    <span className="recovery-dot" aria-hidden="true" />
                    <span className="recovery-label">{event.label}</span>
                    {step && <code>{step.nodeKey}</code>}
                    <time className="tabular" dateTime={event.createdAt}>{formatClock(event.createdAt)}</time>
                  </button>
                </li>
              );
            })}
          </ol>
        </section>
      )}

      {pending.map((approval) => <ApprovalCard key={approval.id} approval={approval} onDecided={() => void bundle.refresh()} />)}

      <div className="detail-grid">
        <div className="detail-main">
          <Card title="Steps" meta="Materialized as the run advances" padded={false}>
            <Timeline
              label="Workflow steps"
              items={run.steps.map((step) => {
                const type = stepType(step.kind);
                const tokens = stepTokens(summaryByStep.get(step.id));
                const models = [...(stepModels.get(step.id) ?? [])].join(", ");
                return {
                  id: step.id,
                  tone: statusTone(step.status),
                  selected: selectedStep?.id === step.id,
                  onSelect: () => setUrl({ step: step.id }),
                  title: (
                    <>
                      <span className="step-name">{step.nodeKey}</span>
                      <Tag>{type.label}</Tag>
                      <StatusPill value={step.status} size="sm" />
                    </>
                  ),
                  meta: (
                    <>
                      <span>attempt {step.attemptCount}/{step.maxAttempts}</span>
                      <span>{formatSpan(step.createdAt, step.completedAt ?? run.finishedAt, now)}</span>
                      {tokens !== null && <span>{formatTokens(tokens)} tokens</span>}
                      {models && <code>{models}</code>}
                    </>
                  ),
                };
              })}
            />
          </Card>

          <TokenPanel summary={data.summary} usage={data.usage} />
          <ResultPanel run={run} usage={data.usage} usageSummary={data.summary} />

          <Card title="History" meta={`${data.history.length} durable events`} actions={<HistoryIcon size={16} aria-hidden="true" />} padded={false}>
            {data.history.length === 0 ? <p className="muted-inline card-pad">No events recorded.</p> : (
              <ol className="history">
                {[...data.history].reverse().map((event) => {
                  const step = run.steps.find((item) => item.id === event.stepId);
                  return (
                    <li key={event.id} className={`history-row history-row--${historyTone(event.type)}`}>
                      <span className="history-seq tabular">#{event.sequence}</span>
                      <time className="tabular" dateTime={event.createdAt} title={formatAbsolute(event.createdAt)}>{formatClock(event.createdAt)}</time>
                      <span className="history-type"><span className="history-dot" aria-hidden="true" />{humanize(event.type)}</span>
                      <span className="history-context">
                        {step && <button type="button" className="link-button" onClick={() => setUrl({ step: step.id })}>{step.nodeKey}</button>}
                        {event.attemptId && <code>attempt {shortId(event.attemptId)}</code>}
                      </span>
                    </li>
                  );
                })}
              </ol>
            )}
          </Card>
        </div>

        {selectedStep && (
          <StepInspector
            step={selectedStep}
            tab={tab}
            onTab={(next) => setUrl({ step: selectedStep.id, tab: next })}
            attempts={data.attempts.filter((attempt) => attempt.stepId === selectedStep.id)}
            usage={data.usage.filter((record) => record.stepId === selectedStep.id)}
            stepSummary={summaryByStep.get(selectedStep.id)}
            tools={data.tools.filter((tool) => tool.stepId === selectedStep.id)}
            now={now}
            onChanged={() => void bundle.refresh()}
          />
        )}
      </div>

      <Dialog
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        title="Cancel this run?"
        description="Unfinished steps are cancelled and the run cannot be resumed. Committed steps and receiver effects are kept."
        footer={(
          <>
            <Button onClick={() => setConfirmCancel(false)} autoFocus>Keep running</Button>
            <Button variant="danger" loading={mutating} onClick={() => { setConfirmCancel(false); void control("cancel"); }}>Cancel run</Button>
          </>
        )}
      />
    </div>
  );
}
