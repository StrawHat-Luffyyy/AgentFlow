import { FileText } from "lucide-react";
import type { JsonValue, RunDetail, UsageRecord } from "./api.js";
import { extractReport, runMode, summarizeUsage } from "./new-run.js";
import { Panel } from "./ui.js";

/** "Scripted" vs "Live · <provider>" so evaluation and real-provider runs can't be confused. */
export function ModeBadge({ providers, size = "md" }: { providers: string[] | undefined; size?: "sm" | "md" }) {
  const mode = runMode(providers);
  if (mode.kind === "none") return null;
  return mode.kind === "scripted"
    ? <span className={`badge badge--neutral badge--${size} mode-badge`} title="Deterministic evaluation provider">Scripted</span>
    : <span className={`badge badge--live badge--${size} mode-badge`} title={`Real provider calls via ${mode.provider}`}>Live · {mode.provider}</span>;
}

export function ResultPanel({ run, usage }: { run: RunDetail; usage: UsageRecord[] }) {
  if (run.publicStatus !== "SUCCEEDED") return null;
  const report = extractReport(run.steps);
  const finalStep = run.steps.at(-1);
  // Token figures come only from persisted usage records returned by the API.
  const totals = summarizeUsage(usage);
  return (
    <Panel title="Result" meta="Committed output of the succeeded run" actions={<FileText size={16} aria-hidden="true" />} className="result-panel">
      {report && (
        <article className="result-report" aria-label="Report">
          <h4>{report.title}</h4>
          <pre className="result-report-body" tabIndex={0}>{report.content}</pre>
          {report.citations.length > 0 && (
            <div className="result-citations">
              <span>Citations</span>
              <ul>{report.citations.map((citation) => <li key={citation}><code>{citation}</code></li>)}</ul>
            </div>
          )}
        </article>
      )}
      {finalStep && (
        <div className="result-final">
          <span className="result-label">Final output · <code>{finalStep.nodeKey}</code></span>
          <pre className="code-block" tabIndex={0}>{finalStep.acceptedOutput === null ? "No output committed." : JSON.stringify(finalStep.acceptedOutput as JsonValue, null, 2)}</pre>
        </div>
      )}
      <footer className="result-usage">
        {totals === null ? "No usage recorded" : (
          <>
            <strong>{totals.input.toLocaleString()} in · {totals.output.toLocaleString()} out</strong>
            {totals.groups.map((group) => (
              <span key={group.label}>
                {group.label}: {group.input.toLocaleString()} in · {group.output.toLocaleString()} out ({group.provenances.join(", ")})
              </span>
            ))}
          </>
        )}
      </footer>
    </Panel>
  );
}
