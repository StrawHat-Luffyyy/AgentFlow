import { Wrench } from "lucide-react";
import { useId, useState } from "react";
import { api, type ToolExecution } from "../api.js";
import { Button, Dialog, Field, InlineAlert, Input, SegmentedControl, Textarea, useToast } from "../design/index.js";
import { parseReceipt } from "../lib/reconcile.js";
import { errorMessage, useSession } from "../lib/session.js";

type Resolution = "CONFIRM_SUCCEEDED" | "FAIL_FINAL";

/**
 * Operator resolution for a side effect whose outcome is UNKNOWN. The runtime never resends;
 * the operator either confirms the receiver applied it (with its receipt) or fails the run for good.
 */
export function ReconcileAction({ tool, onResolved }: { tool: ToolExecution; onResolved: () => void }) {
  const { principal } = useSession();
  const toast = useToast();
  const ids = { receiver: useId(), receipt: useId() };
  const [open, setOpen] = useState(false);
  const [resolution, setResolution] = useState<Resolution>("CONFIRM_SUCCEEDED");
  const [receiverId, setReceiverId] = useState("");
  const [receiptText, setReceiptText] = useState("{\n  \n}");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isOperator = principal?.roles.includes("operator") ?? false;

  const receipt = parseReceipt(receiptText);
  const confirming = resolution === "CONFIRM_SUCCEEDED";
  const valid = !confirming || (receiverId.trim().length > 0 && receiverId.trim().length <= 200 && receipt.ok);

  async function submit() {
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.reconcileToolExecution(tool.id, confirming && receipt.ok
        ? { resolution: "CONFIRM_SUCCEEDED", receiverId: receiverId.trim(), receipt: receipt.value }
        : { resolution: "FAIL_FINAL" });
      toast.show({ tone: "success", title: confirming ? "Side effect confirmed" : "Run failed for good", description: `Run is now ${result.lifecycle.toLowerCase()}.` });
      setOpen(false);
      onResolved();
    } catch (cause) {
      setError(errorMessage(cause, "Reconciliation failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <InlineAlert tone="warning" action={isOperator
        ? <Button size="sm" variant="secondary" icon={<Wrench size={16} />} onClick={() => setOpen(true)}>Reconcile</Button>
        : undefined}>
        Outcome unknown: the runtime will not resend. {isOperator
          ? "Check the receiver, then record what happened."
          : <>An operator resolves it (needs the <code>operator</code> role).</>}
      </InlineAlert>
      <Dialog
        open={open}
        onOpenChange={(next) => { if (!busy) setOpen(next); }}
        title={`Reconcile ${tool.toolName}`}
        description="Record what the receiver actually did. This is final and is never sent to the receiver."
        footer={(
          <>
            <Button onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
            <Button variant={confirming ? "primary" : "danger"} loading={busy} disabled={!valid} onClick={() => void submit()}>
              {confirming ? "Confirm succeeded" : "Fail run"}
            </Button>
          </>
        )}
      >
        <div className="reconcile-form">
          <SegmentedControl<Resolution>
            label="Resolution"
            value={resolution}
            onChange={setResolution}
            options={[
              { value: "CONFIRM_SUCCEEDED", label: "It succeeded", help: "The receiver applied it; the run continues" },
              { value: "FAIL_FINAL", label: "It did not happen", help: "The run fails; nothing is resent" },
            ]}
          />
          {confirming && (
            <>
              <Field label="Receiver id" htmlFor={ids.receiver} help="The id the receiver assigned to this effect.">
                <Input id={ids.receiver} value={receiverId} maxLength={200} onChange={(event) => setReceiverId(event.target.value)} />
              </Field>
              <Field label="Receipt (JSON object)" htmlFor={ids.receipt} {...(receipt.ok ? { help: "Stored as the effect's receipt." } : { error: receipt.error })}>
                <Textarea id={ids.receipt} mono rows={6} value={receiptText} invalid={!receipt.ok} onChange={(event) => setReceiptText(event.target.value)} />
              </Field>
            </>
          )}
          {error && <InlineAlert>{error}</InlineAlert>}
        </div>
      </Dialog>
    </>
  );
}
