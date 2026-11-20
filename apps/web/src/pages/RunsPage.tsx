import { Inbox, Plus, SearchX } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { api, type RunSummary, type WorkflowSummary } from "../api.js";
import { Button, EmptyState, ErrorState, ProgressBar, Select, Skeleton, StatusPill, Tooltip, statusTone } from "../design/index.js";
import { formatAbsolute, formatCost, formatRelative, formatSpan, formatTokens, shortId } from "../lib/format.js";
import {
  isFiltered, parseRunListQuery, rangePresets, serializeRunListQuery, statusPresets, toApiFilters,
  type RangePreset, type RunListQuery, type StatusPreset,
} from "../lib/run-filters.js";
import { useNow, usePolling } from "../lib/session.js";
import { NewRunDrawer } from "../NewRunDrawer.js";
import { useBreadcrumbs } from "../shell/AppShell.js";
import { LiveIndicator, PageHeader, ProviderBadge } from "./common.js";

function TokensCell({ run }: { run: RunSummary }) {
  const total = run.inputTokens + run.outputTokens;
  if (!run.providers?.length) return <span className="muted">—</span>;
  return (
    <Tooltip content={`${run.inputTokens.toLocaleString("en-US")} input · ${run.outputTokens.toLocaleString("en-US")} output (persisted usage records)`}>
      <span tabIndex={0}>{formatTokens(total)}</span>
    </Tooltip>
  );
}

function BudgetCell({ run }: { run: RunSummary }) {
  const parts = [
    run.maxTokens ? `${formatTokens(run.maxTokens)} tok` : null,
    run.maxCostUsd ? formatCost(run.maxCostUsd) : null,
  ].filter(Boolean);
  return parts.length ? <span>{parts.join(" · ")}</span> : <span className="muted">—</span>;
}

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 8 }, (_, index) => (
        <tr key={index} aria-hidden="true">
          <td><Skeleton width={84} height={20} radius={999} /></td>
          <td><Skeleton width="70%" /><Skeleton width={64} height={10} /></td>
          <td><Skeleton width={64} height={20} /></td>
          <td><Skeleton width={72} /></td>
          <td className="num"><Skeleton width={48} /></td>
          <td><Skeleton width={96} height={6} /></td>
          <td className="num"><Skeleton width={40} /></td>
          <td><Skeleton width={56} /></td>
        </tr>
      ))}
    </>
  );
}

export function RunsPage() {
  useBreadcrumbs([{ label: "Runs" }]);
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const query = parseRunListQuery(params);
  const queryKey = serializeRunListQuery(query).toString();
  const now = useNow();
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const runs = usePolling(() => api.listRuns(toApiFilters(query, Date.now())), [queryKey]);
  const drawerOpen = params.get("new") === "1";
  const startedRef = useRef(false);

  useEffect(() => { api.listWorkflows().then((body) => setWorkflows(body.workflows)).catch(() => setWorkflows([])); }, []);

  const update = (patch: Partial<RunListQuery>) => setParams(serializeRunListQuery({ ...query, ...patch }, params), { replace: true });
  const setDrawer = (open: boolean) => {
    const next = new URLSearchParams(params);
    if (open) next.set("new", "1"); else next.delete("new");
    setParams(next);
  };

  const workflowOptions = useMemo(() => [
    { value: "all", label: "All workflows" },
    ...workflows.map((workflow) => ({ value: workflow.id, label: workflow.name })),
  ], [workflows]);

  const list = runs.data?.runs ?? [];
  const total = runs.data?.total ?? 0;
  const openRun = (id: string) => navigate(`/runs/${id}`);
  const onRowKey = (event: KeyboardEvent<HTMLTableRowElement>, id: string) => {
    if (event.key === "Enter") openRun(id);
  };

  return (
    <div className="page">
      <PageHeader
        title="Runs"
        description="Durable workflow runs, newest first. Status is derived from PostgreSQL state, never from the queue."
        actions={(
          <>
            <LiveIndicator updatedAt={runs.updatedAt} refreshing={runs.refreshing} error={runs.error} now={now} />
            <Button variant="primary" icon={<Plus size={16} />} onClick={() => setDrawer(true)}>New run</Button>
          </>
        )}
      />

      <div className="filter-bar" role="search" aria-label="Filter runs">
        <Select label="Status" size="sm" value={query.status} onChange={(value) => update({ status: value as StatusPreset })}
          options={Object.entries(statusPresets).map(([value, preset]) => ({ value, label: preset.label }))} />
        <Select label="Workflow" size="sm" value={query.workflow || "all"} onChange={(value) => update({ workflow: value === "all" ? "" : value })}
          options={workflowOptions} />
        <Select label="Created" size="sm" value={query.range} onChange={(value) => update({ range: value as RangePreset })}
          options={Object.entries(rangePresets).map(([value, preset]) => ({ value, label: preset.label }))} />
        {isFiltered(query) && <Button variant="ghost" size="sm" onClick={() => setParams(new URLSearchParams(), { replace: true })}>Clear filters</Button>}
        <span className="filter-count tabular">{runs.data ? `${list.length}${total > list.length ? ` of ${total}` : ""} runs` : ""}</span>
      </div>

      <div className="card">
        {runs.error && !runs.data ? (
          <ErrorState title="Runs could not be loaded" message={runs.error} onRetry={() => void runs.refresh()} />
        ) : runs.data && list.length === 0 ? (
          isFiltered(query)
            ? <EmptyState icon={<SearchX size={20} />} title="No runs match these filters" action={<Button size="sm" onClick={() => setParams(new URLSearchParams())}>Clear filters</Button>}>Try a wider date range or another status.</EmptyState>
            : <EmptyState icon={<Inbox size={20} />} title="No runs yet" action={<Button variant="primary" size="sm" icon={<Plus size={16} />} onClick={() => setDrawer(true)}>Start a run</Button>}>
                Start a scripted run (no API key, no cost) or a live Gemini/Groq run. Runs created from the CLI or API appear here too.
              </EmptyState>
        ) : (
          <div className="table-wrap table-wrap--page">
            <table className="table runs-table">
              <caption className="visually-hidden">Workflow runs</caption>
              <thead>
                <tr>
                  <th scope="col">Status</th>
                  <th scope="col">Workflow</th>
                  <th scope="col">Provider</th>
                  <th scope="col">Started</th>
                  <th scope="col" className="num">Duration</th>
                  <th scope="col">Progress</th>
                  <th scope="col" className="num">Tokens</th>
                  <th scope="col">Budget</th>
                </tr>
              </thead>
              <tbody>
                {!runs.data ? <SkeletonRows /> : list.map((run) => (
                  <tr key={run.id} className="is-interactive" tabIndex={0} onClick={() => openRun(run.id)} onKeyDown={(event) => onRowKey(event, run.id)}
                    aria-label={`${run.workflowName} run ${shortId(run.id)}, ${run.publicStatus}`}>
                    <td><StatusPill value={run.publicStatus} size="sm" /></td>
                    <td className="cell-primary">
                      <Link to={`/runs/${run.id}`} className="cell-link" onClick={(event) => event.stopPropagation()} tabIndex={-1}>{run.workflowName}</Link>
                      <code className="cell-sub">{shortId(run.id)} · v{run.workflowVersion}</code>
                    </td>
                    <td><ProviderBadge providers={run.providers} /></td>
                    <td><time dateTime={run.createdAt} title={formatAbsolute(run.createdAt)}>{formatRelative(run.createdAt, now)}</time></td>
                    <td className="num">{formatSpan(run.createdAt, run.finishedAt, now)}</td>
                    <td>
                      <span className="progress-cell">
                        <ProgressBar value={run.completedStepCount} total={run.stepCount} label={`${run.workflowName} progress`} tone={statusTone(run.publicStatus)} />
                        <span className="tabular">{run.completedStepCount}/{run.stepCount}</span>
                      </span>
                    </td>
                    <td className="num"><TokensCell run={run} /></td>
                    <td><BudgetCell run={run} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <NewRunDrawer
        open={drawerOpen}
        // After a start, the drawer closes itself; navigating to the new run already
        // dropped ?new=1, so rewriting the params here would navigate back to /runs.
        onClose={() => { if (!startedRef.current) setDrawer(false); startedRef.current = false; }}
        onStarted={(id) => { startedRef.current = true; navigate(`/runs/${id}`); }}
        onSessionExpired={() => navigate("/login")}
        {...(query.workflow ? { initialWorkflowId: query.workflow } : {})}
      />
    </div>
  );
}
