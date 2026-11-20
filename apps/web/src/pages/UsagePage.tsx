import { BarChart3 } from "lucide-react";
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { api, type OwnerUsageSeries } from "../api.js";
import { Badge, Card, EmptyState, ErrorState, Select, Skeleton, Tooltip } from "../design/index.js";
import { formatNumber, formatTokens } from "../lib/format.js";
import { useNow, usePolling } from "../lib/session.js";
import { breakdown, isUsageRange, niceMax, savedShare, usageRanges, usageWindow, type UsageRange } from "../lib/usage.js";
import { useBreadcrumbs } from "../shell/AppShell.js";
import { LiveIndicator, PageHeader } from "./common.js";

const series = [
  { key: "billed", label: "Billed", className: "usage-swatch--billed" },
  { key: "savedByReplay", label: "Avoided · journal replay", className: "usage-swatch--replay" },
  { key: "savedByCache", label: "Avoided · response cache", className: "usage-swatch--cache" },
] as const;

function formatDay(day: string, withYear = false): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short", day: "numeric", timeZone: "UTC", ...(withYear ? { year: "numeric" } : {}),
  });
}

function UsageChart({ data }: { data: OwnerUsageSeries }) {
  const bars = data.days.map((day) => ({ day: day.day, ...breakdown(day) }));
  const max = niceMax(Math.max(0, ...bars.map((bar) => bar.billed + bar.savedByReplay + bar.savedByCache)));
  const [active, setActive] = useState<number | null>(null);
  const shown = active === null ? null : bars[active]!;
  const labelEvery = Math.ceil(bars.length / 8);
  const height = 100;
  const scale = (value: number) => (value / max) * height;

  return (
    <div className="usage-chart">
      <div className="usage-chart-readout" aria-live="polite">
        {shown ? (
          <>
            <strong>{formatDay(shown.day, true)}</strong>
            {series.map((entry) => (
              <span key={entry.key}><span className={`usage-swatch ${entry.className}`} aria-hidden="true" />{entry.label}: {formatNumber(shown[entry.key])}</span>
            ))}
          </>
        ) : (
          <span className="muted">Hover a day for its figures. Bars are tokens per UTC day.</span>
        )}
      </div>
      <div className="usage-chart-plot">
        <div className="usage-chart-axis" aria-hidden="true">
          <span>{formatTokens(max)}</span><span>{formatTokens(max / 2)}</span><span>0</span>
        </div>
        <svg className="usage-chart-svg" viewBox={`0 0 ${bars.length} ${height}`} preserveAspectRatio="none"
          role="img" aria-label={`Tokens per day, ${formatDay(bars[0]?.day ?? "")} to ${formatDay(bars.at(-1)?.day ?? "")}`}
          onMouseLeave={() => setActive(null)}>
          <line x1={0} x2={bars.length} y1={height / 2} y2={height / 2} className="usage-gridline" vectorEffect="non-scaling-stroke" />
          {bars.map((bar, index) => {
            let base = height;
            return (
              <g key={bar.day} onMouseEnter={() => setActive(index)} className={active === index ? "is-active" : ""}>
                <rect x={index} y={0} width={1} height={height} className="usage-hit" />
                {series.map((entry) => {
                  const value = scale(bar[entry.key]);
                  base -= value;
                  return value > 0 ? <rect key={entry.key} x={index + 0.15} y={base} width={0.7} height={value} className={`usage-bar ${entry.className}`} /> : null;
                })}
              </g>
            );
          })}
        </svg>
      </div>
      <div className="usage-chart-x" aria-hidden="true">
        {bars.map((bar, index) => <span key={bar.day}>{index % labelEvery === 0 ? formatDay(bar.day) : ""}</span>)}
      </div>
      <ul className="usage-legend">
        {series.map((entry) => <li key={entry.key}><span className={`usage-swatch ${entry.className}`} aria-hidden="true" />{entry.label}</li>)}
      </ul>
    </div>
  );
}

export function UsagePage() {
  useBreadcrumbs([{ label: "Usage" }]);
  const [params, setParams] = useSearchParams();
  const rangeParam = params.get("range");
  const range: UsageRange = isUsageRange(rangeParam) ? rangeParam : "30d";
  const now = useNow();
  // Recompute the window only when the range changes, not every clock tick.
  const span = useMemo(() => usageWindow(range, Date.now()), [range]);
  const usage = usePolling(() => api.getOwnerUsage(span.from, span.to), [span.from, span.to], 15_000);
  const data = usage.data;
  const totals = data ? breakdown(data.totals) : null;
  const share = totals ? savedShare(totals) : null;
  const calls = data ? data.totals.billedCalls + data.totals.replayedCalls + data.totals.cacheHitCalls : 0;
  const provenance = data?.provenance;

  return (
    <div className="page">
      <PageHeader
        title="Usage"
        description="Tokens billed by providers across all your runs, and the calls AgentFlow avoided by replaying its journal or answering from the response cache. Avoided tokens were never billed."
        actions={(
          <>
            <LiveIndicator updatedAt={usage.updatedAt} refreshing={usage.refreshing} error={usage.error} now={now} />
            <Select
              label="Range"
              value={range}
              onChange={(next) => setParams(next === "30d" ? new URLSearchParams() : new URLSearchParams({ range: next }), { replace: true })}
              options={(Object.keys(usageRanges) as UsageRange[]).map((key) => ({ value: key, label: usageRanges[key].label }))}
            />
          </>
        )}
      />

      {usage.loading ? (
        <div className="card card-pad" aria-busy="true"><Skeleton height={16} width="30%" /><Skeleton height={220} /></div>
      ) : usage.error && !data ? (
        <ErrorState title="Usage could not be loaded" message={usage.error} onRetry={() => void usage.refresh()} />
      ) : !data || !totals || calls === 0 ? (
        <div className="card">
          <EmptyState icon={<BarChart3 size={20} />} title={`No LLM calls in the ${usageRanges[range].label.toLowerCase()}`}>
            Usage appears here once a run with an agent step has called a provider.
          </EmptyState>
        </div>
      ) : (
        <>
          <div className="token-grid token-grid--quad">
            <div className="metric">
              <span className="metric-label">Billed tokens</span>
              <span className="metric-value tabular">{formatNumber(totals.billed)}</span>
              <span className="metric-detail">{formatNumber(data.totals.billedCalls)} provider calls · {formatNumber(data.totals.billedInputTokens)} in · {formatNumber(data.totals.billedOutputTokens)} out</span>
            </div>
            <div className="metric metric--success">
              <span className="metric-label">Avoided by journal replay</span>
              <span className="metric-value tabular">{formatNumber(totals.savedByReplay)}</span>
              <span className="metric-detail">{formatNumber(data.totals.replayedCalls)} calls not repeated after a crash or retry</span>
            </div>
            <div className="metric metric--success">
              <span className="metric-label">Avoided by response cache</span>
              <span className="metric-value tabular">{formatNumber(totals.savedByCache)}</span>
              <span className="metric-detail">{formatNumber(data.totals.cacheHitCalls)} identical requests answered from earlier responses</span>
            </div>
            <div className="metric">
              <span className="metric-label">Share avoided</span>
              <span className="metric-value tabular">{share === null ? "—" : `${(share * 100).toFixed(1)}%`}</span>
              <span className="metric-detail">Of billed plus avoided tokens</span>
            </div>
          </div>

          <Card title="Tokens per day" meta={`${usageRanges[range].label} · UTC`}>
            <UsageChart data={data} />
            {provenance && (
              <p className="metric-note">
                Token counts by provenance:{" "}
                <Tooltip content="Counts the provider returned with the response"><span tabIndex={0}><Badge tone="success">{provenance.reported} reported</Badge></span></Tooltip>{" "}
                <Tooltip content="Estimated locally, e.g. by the scripted evaluation provider"><span tabIndex={0}><Badge tone="warning">{provenance.estimated} estimated</Badge></span></Tooltip>{" "}
                <Badge tone="neutral">{provenance.unknown} unknown</Badge>
                {data.totals.unreportedCalls > 0 && ` · ${data.totals.unreportedCalls} calls reported no counts and are excluded, never estimated.`}
              </p>
            )}
          </Card>

          <Card title="By model" padded={false}>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Provider</th><th>Model</th><th className="num">Calls</th><th className="num">Billed in</th>
                    <th className="num">Billed out</th><th className="num">Avoided · replay</th><th className="num">Avoided · cache</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byModel.map((row) => {
                    const value = breakdown(row);
                    return (
                      <tr key={`${row.provider}/${row.model}`}>
                        <td>{row.provider}</td>
                        <td><code>{row.model}</code></td>
                        <td className="num">{formatNumber(row.billedCalls)}</td>
                        <td className="num">{formatNumber(row.billedInputTokens)}</td>
                        <td className="num">{formatNumber(row.billedOutputTokens)}</td>
                        <td className="num">{formatNumber(value.savedByReplay)}</td>
                        <td className="num">{formatNumber(value.savedByCache)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
