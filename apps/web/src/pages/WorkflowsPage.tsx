import { ArrowRight, ListChecks, Lock, Play, Workflow as WorkflowIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api, type WorkflowVersionSummary } from "../api.js";
import { Badge, Card, CodeBlock, EmptyState, ErrorState, KeyValue, Skeleton, Tag, Tooltip } from "../design/index.js";
import { formatAbsolute, formatRelative, shortId } from "../lib/format.js";
import { useNow, usePolling } from "../lib/session.js";
import { useBreadcrumbs } from "../shell/AppShell.js";
import { PageHeader, ProviderBadge, stepType } from "./common.js";

/** The reference workflow is started through the drawer's reference option, which (re)creates its version. */
const isReference = (name: string) => name.startsWith("cloud-comparison-");

function newRunLink(workflowId: string, name: string): string {
  return isReference(name) ? "/runs?new=1" : `/runs?workflow=${workflowId}&new=1`;
}

export function WorkflowsPage() {
  useBreadcrumbs([{ label: "Workflows" }]);
  const navigate = useNavigate();
  const now = useNow(30_000);
  const workflows = usePolling(() => api.listWorkflows(), [], 15_000);
  const list = workflows.data?.workflows ?? [];

  return (
    <div className="page">
      <PageHeader title="Workflows" description="Workflow definitions you own. Each version is immutable once created; runs pin the version they started on." />
      <div className="card">
        {workflows.loading ? (
          <div className="card-pad" aria-busy="true"><Skeleton height={14} width="50%" /><Skeleton height={14} width="70%" /><Skeleton height={14} width="40%" /></div>
        ) : workflows.error && !workflows.data ? (
          <ErrorState title="Workflows could not be loaded" message={workflows.error} onRetry={() => void workflows.refresh()} />
        ) : list.length === 0 ? (
          <EmptyState icon={<WorkflowIcon size={20} />} title="No workflows yet"
            action={<Link to="/runs?new=1" className="btn btn--primary btn--sm"><Play size={16} aria-hidden="true" /><span>Start the reference workflow</span></Link>}>
            Starting the cloud-comparison reference run creates its workflow. Other workflows are created through the API or the CLI.
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Name</th><th>Description</th><th className="num">Latest</th><th className="num">Versions</th><th>Created</th></tr></thead>
              <tbody>
                {list.map((workflow) => (
                  <tr key={workflow.id} className="is-interactive" onClick={() => navigate(`/workflows/${workflow.id}`)}>
                    <td>
                      <Link to={`/workflows/${workflow.id}`} onClick={(event) => event.stopPropagation()}><strong>{workflow.name}</strong></Link>
                      {isReference(workflow.name) && <> <Badge tone="neutral">Reference</Badge></>}
                    </td>
                    <td className="cell-truncate cell-muted" title={workflow.description}>{workflow.description || "—"}</td>
                    <td className="num">{workflow.latestVersion === null ? "—" : `v${workflow.latestVersion}`}</td>
                    <td className="num">{workflow.versionCount}</td>
                    <td><Tooltip content={formatAbsolute(workflow.createdAt)}><span tabIndex={0}>{formatRelative(workflow.createdAt, now)}</span></Tooltip></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function VersionSteps({ version }: { version: WorkflowVersionSummary }) {
  if (!version.steps) return <p className="muted-inline">{version.stepCount} steps.</p>;
  return (
    <ol className="wf-steps">
      {version.steps.map((step, index) => {
        const type = stepType(step.kind);
        const { key, kind: _kind, handler, ...rest } = step;
        return (
          <li key={key} className="wf-step">
            <span className="wf-step-index tabular">{index + 1}</span>
            <span className="wf-step-icon" aria-hidden="true">{type.icon}</span>
            <div className="wf-step-body">
              <div className="wf-step-head"><code>{key}</code><Tag>{type.label}</Tag><span className="muted">{handler}</span></div>
              {Object.keys(rest).length > 0 && (
                <details className="wf-step-details">
                  <summary>Configuration</summary>
                  <CodeBlock value={rest} maxHeight={240} />
                </details>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function WorkflowDetailPage() {
  const { id = "" } = useParams();
  const workflow = usePolling(() => api.getWorkflow(id), [id], 15_000);
  const detail = workflow.data;
  useBreadcrumbs([{ label: "Workflows", to: "/workflows" }, { label: detail?.name ?? shortId(id) }]);
  const versions = [...(detail?.versions ?? [])].sort((a, b) => b.version - a.version);
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => { setSelected(null); }, [id]);
  const version = versions.find((entry) => entry.id === selected) ?? versions[0];

  if (workflow.loading) return <div className="page" aria-busy="true"><Skeleton height={28} width="30%" /><Skeleton height={240} /></div>;
  if (!detail) {
    const notFound = workflow.error?.includes("(404)") || workflow.error?.includes("(400)");
    return (
      <div className="page">
        {notFound
          ? <div className="card"><EmptyState icon={<WorkflowIcon size={20} />} title="Workflow not found" action={<Link to="/workflows" className="btn btn--secondary btn--sm"><span>All workflows</span></Link>}>It does not exist or belongs to another owner.</EmptyState></div>
          : <ErrorState title="Workflow could not be loaded" message={workflow.error ?? "Unknown error"} onRetry={() => void workflow.refresh()} />}
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        title={detail.name}
        description={detail.description || undefined}
        meta={<><code>{shortId(detail.id)}</code><span className="muted">Created {formatAbsolute(detail.createdAt)}</span></>}
        actions={(
          <>
            <Link to={`/runs?workflow=${detail.id}`} className="btn btn--secondary btn--md"><ListChecks size={16} aria-hidden="true" /><span>Runs</span></Link>
            {versions.length > 0 && (
              <Link to={newRunLink(detail.id, detail.name)} className="btn btn--primary btn--md"><Play size={16} aria-hidden="true" /><span>Start run</span></Link>
            )}
          </>
        )}
      />
      {versions.length === 0 ? (
        <div className="card"><EmptyState icon={<WorkflowIcon size={20} />} title="No versions yet">Create a version through the API or CLI before starting a run.</EmptyState></div>
      ) : (
        <div className="wf-layout">
          <Card title="Versions" padded={false}>
            <ul className="wf-versions" role="listbox" aria-label="Versions">
              {versions.map((entry) => (
                <li key={entry.id}>
                  <button type="button" role="option" aria-selected={entry.id === version?.id}
                    className={`wf-version ${entry.id === version?.id ? "is-selected" : ""}`} onClick={() => setSelected(entry.id)}>
                    <span className="wf-version-name">v{entry.version}{entry === versions[0] && <Badge tone="info">Latest</Badge>}</span>
                    <span className="muted">{entry.stepCount} steps · {formatAbsolute(entry.createdAt)}</span>
                    <ArrowRight size={14} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          </Card>
          {version && (
            <Card title={`Version ${version.version}`} meta={<span className="wf-immutable"><Lock size={12} aria-hidden="true" />Immutable</span>}>
              <KeyValue columns={2} items={[
                { label: "Version id", value: <code>{shortId(version.id)}</code> },
                { label: "Providers", value: <ProviderBadge providers={version.providers} /> },
              ]} />
              <h3 className="wf-section-title">Steps</h3>
              <VersionSteps version={version} />
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
