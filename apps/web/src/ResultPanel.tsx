import { FileText } from "lucide-react";
import type { RunDetail, ServerUsageSummary, UsageRecord } from "./api.js";
import { Card, CodeBlock } from "./design/index.js";
import { extractReport, reuseDetail, summarizeUsage, usageDetail } from "./new-run.js";

/** Report and final output of a succeeded run; token lines come only from persisted usage records. */
export function ResultPanel({ run, usage, usageSummary }: {
  run: RunDetail;
  usage: UsageRecord[];
  usageSummary?: ServerUsageSummary | null;
}) {
  if (run.publicStatus !== "SUCCEEDED") return null;
  const report = extractReport(run.steps);
  const finalStep = run.steps.at(-1);
  const totals = summarizeUsage(usage);
  return (
    <Card title="Result" meta="Committed output of the succeeded run" actions={<FileText size={16} aria-hidden="true" />} className="result-panel">
      {report && (
        <article className="result-report" aria-label="Report">
          <h3>{report.title}</h3>
          <pre className="result-report-body" tabIndex={0}>{report.content}</pre>
          {report.citations.length > 0 && (
            <div className="result-citations">
              <span className="metric-label">Citations</span>
              <ul>{report.citations.map((citation) => <li key={citation}><code>{citation}</code></li>)}</ul>
            </div>
          )}
        </article>
      )}
      {finalStep && (
        <div className="result-final">
          <span className="metric-label">Final output · <code>{finalStep.nodeKey}</code></span>
          <CodeBlock value={finalStep.acceptedOutput} empty="No output committed." maxHeight={280} />
        </div>
      )}
      <footer className="result-usage">
        <strong>{usageDetail(totals)}</strong>
        {totals?.groups.map((group) => (
          <span key={group.label}>
            {group.label}: {group.input.toLocaleString()} in · {group.output.toLocaleString()} out
            {group.unreported > 0 ? ` + ${group.unreported} unreported` : ""} ({group.provenances.join(", ")})
          </span>
        ))}
        {reuseDetail(usageSummary).map((line) => <span key={line}>{line}</span>)}
      </footer>
    </Card>
  );
}
