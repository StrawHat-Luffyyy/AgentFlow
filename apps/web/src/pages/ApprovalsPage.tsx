import { ArrowRight, ShieldCheck } from "lucide-react";
import { Link } from "react-router";
import { api } from "../api.js";
import { ApprovalCard } from "../components/ApprovalCard.js";
import { EmptyState, ErrorState, Skeleton } from "../design/index.js";
import { formatAbsolute, formatRelative, shortId } from "../lib/format.js";
import { useNow, usePolling, useSession } from "../lib/session.js";
import { useBreadcrumbs } from "../shell/AppShell.js";
import { LiveIndicator, PageHeader } from "./common.js";

/** Pending, unexpired approvals across the owner's runs that one of the viewer's roles can decide. */
export function ApprovalsPage() {
  useBreadcrumbs([{ label: "Approvals" }]);
  const { principal } = useSession();
  const now = useNow();
  const approvals = usePolling(() => api.listApprovals(), [], 3_000);
  const list = approvals.data?.approvals ?? [];
  const roles = principal?.roles ?? [];

  return (
    <div className="page">
      <PageHeader
        title="Approvals"
        description="Runs parked on a human checkpoint. A waiting run holds no worker; each decision is bound to the exact payload by its hash."
        actions={<LiveIndicator updatedAt={approvals.updatedAt} refreshing={approvals.refreshing} error={approvals.error} now={now} />}
        meta={<span className="muted">Shown for your roles: {roles.length ? roles.map((role) => <code key={role} className="role-code">{role}</code>) : "none"}</span>}
      />
      {approvals.loading ? (
        <div className="card card-pad" aria-busy="true"><Skeleton height={16} width="40%" /><Skeleton height={120} /></div>
      ) : approvals.error && !approvals.data ? (
        <ErrorState title="Approvals could not be loaded" message={approvals.error} onRetry={() => void approvals.refresh()} />
      ) : list.length === 0 ? (
        <div className="card">
          <EmptyState icon={<ShieldCheck size={20} />} title="Nothing waiting for you"
            action={<Link to="/runs?status=attention" className="btn btn--secondary btn--sm"><span>See waiting runs</span></Link>}>
            {roles.length === 0
              ? "You have no reviewer roles, so no approvals are routed to you."
              : "No pending approval needs one of your roles right now."}
          </EmptyState>
        </div>
      ) : (
        <div className="approvals-list">
          {list.map((approval) => (
            <div key={approval.id} className="approvals-item">
              <div className="approvals-item-head">
                <Link to={`/runs/${approval.runId}`} className="approvals-run">
                  Run <code>{shortId(approval.runId)}</code><ArrowRight size={14} aria-hidden="true" />
                </Link>
                <span className="muted">Requested {formatRelative(approval.createdAt, now)}</span>
              </div>
              <ApprovalCard
                approval={approval}
                title="Publication approval"
                meta={`Expires ${formatAbsolute(approval.expiresAt)}`}
                onDecided={() => void approvals.refresh()}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
