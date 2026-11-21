import { Check, ShieldCheck, X } from "lucide-react";
import { useState } from "react";
import { api, type Approval } from "../api.js";
import { Button, Card, CodeBlock, Dialog, IdChip, KeyValue, useToast } from "../design/index.js";
import { formatAbsolute } from "../lib/format.js";
import { errorMessage, useSession } from "../lib/session.js";

/** A pending approval: payload-hash-bound decision, role-gated, with an explicit confirm step. */
export function ApprovalCard({ approval, onDecided, title = "Approval required", meta }: { approval: Approval; onDecided: () => void; title?: string; meta?: string }) {
  const { principal } = useSession();
  const toast = useToast();
  const [confirm, setConfirm] = useState<"APPROVE" | "REJECT" | null>(null);
  const [busy, setBusy] = useState(false);
  const canDecide = principal?.roles.includes(approval.reviewerRole) ?? false;
  async function decide(decision: "APPROVE" | "REJECT") {
    setBusy(true);
    try {
      await api.decideApproval(approval, decision);
      toast.show({ tone: "success", title: decision === "APPROVE" ? "Publication approved" : "Publication rejected" });
      // The shell's pending-approvals badge listens for this instead of waiting for its next poll.
      window.dispatchEvent(new Event("agentflow:approvals-changed"));
      onDecided();
    } catch (cause) {
      toast.show({ tone: "danger", title: "Decision failed", description: errorMessage(cause) });
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  }
  return (
    <Card id={`approval-${approval.id}`} title={title} meta={meta ?? `Expires ${formatAbsolute(approval.expiresAt)}`}
      className="approval-card" actions={<ShieldCheck size={16} aria-hidden="true" />}>
      <p className="approval-lead">The decision is bound to the exact persisted payload by its hash. A changed payload cannot reuse it.</p>
      <KeyValue columns={2} items={[
        { label: "Required role", value: <code>{approval.reviewerRole}</code> },
        { label: "Payload hash", value: <IdChip value={approval.payloadHash} display={`${approval.payloadHash.slice(0, 16)}…`} /> },
      ]} />
      <CodeBlock value={approval.proposal} label="Proposal" maxHeight={260} />
      <div className="approval-actions">
        {!canDecide && <span className="approval-note">You need the <code>{approval.reviewerRole}</code> role to decide.</span>}
        <Button variant="danger" icon={<X size={16} />} disabled={!canDecide || busy} onClick={() => setConfirm("REJECT")}>Reject</Button>
        <Button variant="primary" icon={<Check size={16} />} disabled={!canDecide || busy} onClick={() => setConfirm("APPROVE")}>Approve</Button>
      </div>
      <Dialog
        open={confirm !== null}
        onOpenChange={(open) => { if (!open) setConfirm(null); }}
        title={confirm === "APPROVE" ? "Approve this publication?" : "Reject this publication?"}
        description={confirm === "APPROVE"
          ? "The run continues and publishes the exact payload shown, once."
          : "The run fails with APPROVAL_REJECTED. Starting again means a new run."}
        footer={(
          <>
            <Button onClick={() => setConfirm(null)} autoFocus>Keep reviewing</Button>
            <Button variant={confirm === "APPROVE" ? "primary" : "danger"} loading={busy} onClick={() => void decide(confirm!)}>
              {confirm === "APPROVE" ? "Approve" : "Reject"}
            </Button>
          </>
        )}
      />
    </Card>
  );
}
