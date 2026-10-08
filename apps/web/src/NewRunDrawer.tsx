import { ChevronDown, ChevronRight, Play, X } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { api, ApiError, type ProviderAvailability, type WorkflowSummary, type WorkflowVersionSummary } from "./api.js";
import { deadlineMsFromMinutes, parseRunInput, readiness, referenceTemplate, SCRIPTED_PROVIDER } from "./new-run.js";
import { Button, IconButton, InlineAlert } from "./ui.js";

const REFERENCE = "reference";
const LIVE_PROVIDER = "gemini";
const FALLBACK_MODEL = "gemini-3.5-flash";
const AVAILABILITY_POLL_MS = 5_000;

type Mode = "scripted" | "live";

function errorMessage(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.status === 0) return "AgentFlow API is unreachable";
    if (cause.status === 404) return "That workflow version no longer exists";
    return cause.message;
  }
  return cause instanceof Error ? cause.message : "Could not start the run";
}

export function NewRunDrawer({
  open,
  onClose,
  onStarted,
  onSessionExpired,
}: {
  open: boolean;
  onClose: () => void;
  onStarted: (runId: string) => void;
  onSessionExpired: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const ids = { title: useId(), workflow: useId(), version: useId(), model: useId(), input: useId(), inputError: useId(), key: useId(), deadline: useId() };

  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [workflowId, setWorkflowId] = useState<string>(REFERENCE);
  const [versions, setVersions] = useState<WorkflowVersionSummary[]>([]);
  const [versionId, setVersionId] = useState<string>("");
  const [mode, setMode] = useState<Mode>("scripted");
  const [model, setModel] = useState<string>(FALLBACK_MODEL);
  const [availability, setAvailability] = useState<ProviderAvailability | null>(null);
  const [inputText, setInputText] = useState(() => referenceTemplate(new Date()));
  const [inputDirty, setInputDirty] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [creationKey, setCreationKey] = useState("");
  const [deadline, setDeadline] = useState("5");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isReference = workflowId === REFERENCE;
  const template = useCallback(() => (workflowId === REFERENCE ? referenceTemplate(new Date()) : "{}"), [workflowId]);

  // The parent re-renders every second; keep the callback stable so effects below don't refire.
  const sessionExpired = useRef(onSessionExpired);
  sessionExpired.current = onSessionExpired;
  const handleFailure = useCallback((cause: unknown) => {
    if (cause instanceof ApiError && cause.status === 401) {
      sessionExpired.current();
      return;
    }
    setError(errorMessage(cause));
  }, []);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  // Reset transient state each time the drawer opens; workflows may have changed meanwhile.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setSubmitting(false);
    // Fresh timestamped publication target per opening unless the user edited the input.
    if (!inputDirty) setInputText(template());
    api.listWorkflows().then((body) => setWorkflows(body.workflows)).catch(handleFailure);
    // Intentionally runs only when the drawer opens, not on every input edit.
  }, [open, handleFailure]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const load = () => api.runtimeProviders()
      .then((body) => { if (!cancelled) setAvailability(body); })
      .catch((cause: unknown) => {
        if (cause instanceof ApiError && cause.status === 401) sessionExpired.current();
        else if (!cancelled) setAvailability(null);
      });
    void load();
    const timer = window.setInterval(() => void load(), AVAILABILITY_POLL_MS);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [open]);

  useEffect(() => {
    if (!open || isReference) { setVersions([]); setVersionId(""); return; }
    let cancelled = false;
    api.getWorkflow(workflowId).then((detail) => {
      if (cancelled) return;
      const sorted = [...detail.versions].sort((a, b) => b.version - a.version);
      setVersions(sorted);
      setVersionId(sorted[0]?.id ?? "");
    }).catch((cause: unknown) => { if (!cancelled) handleFailure(cause); });
    return () => { cancelled = true; };
  }, [open, isReference, workflowId, handleFailure]);

  useEffect(() => {
    if (!inputDirty) setInputText(template());
  }, [template, inputDirty]);

  const geminiModels = useMemo(() => {
    const advertised = availability?.providers.find((provider) => provider.name === LIVE_PROVIDER)?.models ?? [];
    return advertised.length > 0 ? advertised : [FALLBACK_MODEL];
  }, [availability]);
  useEffect(() => {
    if (!geminiModels.includes(model)) setModel(geminiModels[0]!);
  }, [geminiModels, model]);

  const selectedVersion = versions.find((version) => version.id === versionId);
  const required = isReference ? [mode === "live" ? LIVE_PROVIDER : SCRIPTED_PROVIDER] : selectedVersion?.providers ?? [];
  const ready = readiness(required, availability);
  const parsedInput = parseRunInput(inputText);
  const parsedDeadline = deadlineMsFromMinutes(deadline);
  const keyTooLong = creationKey.trim().length > 200;
  const missingVersion = !isReference && !selectedVersion;
  const canStart = parsedInput.ok && parsedDeadline.ok && !keyTooLong && !ready.blocking && !missingVersion && !submitting;
  const liveProvider = isReference
    ? (mode === "live" ? LIVE_PROVIDER : undefined)
    : (selectedVersion?.providers ?? []).find((name) => name !== SCRIPTED_PROVIDER);
  const liveLabel = liveProvider === LIVE_PROVIDER ? "Gemini" : liveProvider;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canStart || !parsedInput.ok || !parsedDeadline.ok) return;
    setSubmitting(true);
    setError(null);
    try {
      const workflowVersionId = isReference
        ? (await api.setupReference(mode === "live" ? { mode: "live", provider: LIVE_PROVIDER, model } : { mode: "scripted" })).workflowVersionId
        : versionId;
      const run = await api.createRun({
        workflowVersionId,
        input: parsedInput.value,
        deadlineMs: parsedDeadline.value,
        ...(creationKey.trim() ? { creationKey: creationKey.trim() } : {}),
      });
      setInputDirty(false);
      setCreationKey("");
      onStarted(run.id);
      onClose();
    } catch (cause) {
      handleFailure(cause);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      className="drawer"
      aria-labelledby={ids.title}
      onClose={onClose}
      onClick={(event) => { if (event.target === dialog.current) onClose(); }}
    >
      <form className="drawer-form" onSubmit={(event) => void submit(event)} noValidate>
        <header className="drawer-header">
          <h2 id={ids.title}>New run</h2>
          <IconButton type="button" label="Close" onClick={onClose}><X size={16} /></IconButton>
        </header>

        <div className="drawer-body">
          <div className="field">
            <label htmlFor={ids.workflow}>Workflow</label>
            <select id={ids.workflow} className="select" value={workflowId} onChange={(event) => setWorkflowId(event.target.value)}>
              <option value={REFERENCE}>Cloud comparison (reference)</option>
              {workflows.filter((workflow) => !workflow.name.startsWith("cloud-comparison-")).map((workflow) => (
                <option key={workflow.id} value={workflow.id} disabled={workflow.latestVersion === null}>
                  {workflow.name}{workflow.latestVersion === null ? " · no versions" : ` · v${workflow.latestVersion}`}
                </option>
              ))}
            </select>
          </div>

          {isReference ? (
            <fieldset className="field">
              <legend>Execution mode</legend>
              <div className="segmented" role="radiogroup">
                {([
                  ["scripted", "Scripted", "Deterministic evaluation provider · no API key, no cost"],
                  ["live", "Live", "Real Google Gemini calls · uses tokens"],
                ] as const).map(([value, label, help]) => (
                  <label key={value} className={`segmented-option ${mode === value ? "segmented-option--selected" : ""}`}>
                    <input type="radio" name="mode" value={value} checked={mode === value} onChange={() => setMode(value)} />
                    <span className="segmented-label">{label}</span>
                    <span className="segmented-help">{help}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          ) : (
            <div className="field">
              <label htmlFor={ids.version}>Version</label>
              <select id={ids.version} className="select" value={versionId} onChange={(event) => setVersionId(event.target.value)} disabled={versions.length === 0}>
                {versions.length === 0 && <option value="">Loading versions…</option>}
                {versions.map((version) => (
                  <option key={version.id} value={version.id}>
                    v{version.version} · {version.stepCount} steps · {version.providers.length ? version.providers.join(", ") : "no LLM"}
                  </option>
                ))}
              </select>
              <span className="field-help">Provider and model are fixed by the version's definition.</span>
            </div>
          )}

          {isReference && mode === "live" && (
            <div className="field-row">
              <div className="field">
                <span className="field-label">Provider</span>
                <span className="readonly-value"><code>{LIVE_PROVIDER}</code></span>
              </div>
              <div className="field">
                <label htmlFor={ids.model}>Model</label>
                <select id={ids.model} className="select" value={model} onChange={(event) => setModel(event.target.value)}>
                  {geminiModels.map((name) => <option key={name} value={name}>{name}</option>)}
                </select>
              </div>
            </div>
          )}

          <p className={`readiness readiness--${ready.state}`} role="status" aria-live="polite">
            <span className="readiness-dot" aria-hidden="true" />
            {ready.message}
          </p>

          <div className="field">
            <div className="field-label-row">
              <label htmlFor={ids.input}>Input (JSON)</label>
              <button type="button" className="link-button" onClick={() => { setInputText(template()); setInputDirty(false); }}>
                Reset to template
              </button>
            </div>
            <textarea
              id={ids.input}
              className={`json-input ${parsedInput.ok ? "" : "json-input--invalid"}`}
              value={inputText}
              spellCheck={false}
              rows={12}
              aria-invalid={!parsedInput.ok}
              aria-describedby={ids.inputError}
              onChange={(event) => { setInputText(event.target.value); setInputDirty(true); }}
            />
            <span id={ids.inputError} className={parsedInput.ok ? "field-help" : "field-error"} aria-live="polite">
              {parsedInput.ok ? "Must be a JSON object." : parsedInput.error}
            </span>
          </div>

          <button type="button" className="disclosure" aria-expanded={advanced} onClick={() => setAdvanced((value) => !value)}>
            {advanced ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
            Advanced
          </button>
          {advanced && (
            <div className="field-row">
              <div className="field">
                <label htmlFor={ids.key}>Creation key</label>
                <input id={ids.key} className="text-input" value={creationKey} maxLength={200}
                  placeholder="Optional — repeats return the same run" onChange={(event) => setCreationKey(event.target.value)} />
              </div>
              <div className="field">
                <label htmlFor={ids.deadline}>Deadline (minutes)</label>
                <input id={ids.deadline} className="text-input" inputMode="numeric" value={deadline}
                  aria-invalid={!parsedDeadline.ok} onChange={(event) => setDeadline(event.target.value)} />
                {!parsedDeadline.ok && <span className="field-error">{parsedDeadline.error}</span>}
              </div>
            </div>
          )}

          {error && <InlineAlert>{error}</InlineAlert>}
        </div>

        <footer className="drawer-footer">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={submitting} disabled={!canStart} icon={<Play size={14} />}>
            {liveLabel ? `Start live run · ${liveLabel}` : "Start run"}
          </Button>
        </footer>
      </form>
    </dialog>
  );
}
