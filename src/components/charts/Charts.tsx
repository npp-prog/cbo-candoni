import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { CHART_CHROME, SEQUENTIAL_BLUE, SERIES_ORDER } from './palette';
import { formatPeso, toPesos } from '@/lib/money';
import type { Centavos } from '@/types/common';

/**
 * Chart wrappers.
 *
 * Every chart in CFMS plots pesos on a single axis. There is deliberately no
 * dual-axis option: putting obligations and a utilisation percentage on two
 * y-scales in one frame makes the crossing point look meaningful when it is an
 * artefact of the scales chosen. Where two measures of different kinds need
 * comparing, they get two charts.
 *
 * Amounts arrive as centavos and are converted to pesos only for the axis
 * scale; every label and tooltip is formatted through `formatPeso`, so what a
 * user reads is always the exact figure.
 */

const AXIS_STYLE = { fontSize: 11, fill: CHART_CHROME.text };

/** Compact peso axis labels: 1.2M, 450K. Full figures live in the tooltip. */
function compactPeso(pesos: number): string {
  const abs = Math.abs(pesos);
  if (abs >= 1_000_000) return `${(pesos / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1_000) return `${(pesos / 1_000).toFixed(0)}K`;
  return pesos.toFixed(0);
}

function TooltipBox({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color: string }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md border border-slate-200 bg-white px-3 py-2 shadow-raised">
      <p className="mb-1 text-xs font-medium text-navy-900">{label}</p>
      {payload.map((entry) => (
        <div key={entry.name} className="flex items-center gap-2 text-xs">
          <span
            className="h-2 w-2 shrink-0 rounded-sm"
            style={{ backgroundColor: entry.color }}
            aria-hidden="true"
          />
          <span className="text-slate-600">{entry.name}</span>
          <span className="ml-auto font-mono tabular text-navy-900">
            {formatPeso(Math.round(entry.value * 100))}
          </span>
        </div>
      ))}
    </div>
  );
}

export interface SeriesSpec {
  key: string;
  label: string;
}

/**
 * Trend over time. Lines, 2px, with markers large enough to hit.
 */
export function TrendChart({
  data,
  series,
  xKey = 'label',
  height = 240,
}: {
  data: Array<Record<string, string | number>>;
  series: SeriesSpec[];
  xKey?: string;
  height?: number;
}) {
  const pesoData = data.map((row) => {
    const out: Record<string, string | number> = { [xKey]: row[xKey] };
    for (const s of series) out[s.key] = toPesos(Number(row[s.key] ?? 0));
    return out;
  });

  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={pesoData} margin={{ top: 8, right: 8, bottom: 0, left: 4 }}>
        <CartesianGrid stroke={CHART_CHROME.grid} vertical={false} />
        <XAxis dataKey={xKey} tick={AXIS_STYLE} tickLine={false} axisLine={{ stroke: CHART_CHROME.grid }} />
        <YAxis
          tick={AXIS_STYLE}
          tickLine={false}
          axisLine={false}
          tickFormatter={compactPeso}
          width={54}
        />
        <Tooltip content={<TooltipBox />} cursor={{ stroke: CHART_CHROME.axis, strokeDasharray: '3 3' }} />
        {/* A legend is always present for two or more series, so identity
            never rests on colour alone. */}
        {series.length > 1 && (
          <Legend
            iconType="square"
            iconSize={9}
            wrapperStyle={{ fontSize: 11, color: CHART_CHROME.text, paddingTop: 8 }}
          />
        )}
        {series.map((s, i) => (
          <Line
            key={s.key}
            type="monotone"
            dataKey={s.key}
            name={s.label}
            stroke={SERIES_ORDER[i % SERIES_ORDER.length]}
            strokeWidth={2}
            dot={{ r: 2.5, strokeWidth: 0, fill: SERIES_ORDER[i % SERIES_ORDER.length] }}
            activeDot={{ r: 4.5, strokeWidth: 2, stroke: CHART_CHROME.surface }}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

/**
 * Magnitude comparison. Bars with rounded data-ends anchored to the baseline
 * and a 2px gap between adjacent fills.
 */
export function ComparisonChart({
  data,
  series,
  xKey = 'label',
  height = 240,
  horizontal = false,
}: {
  data: Array<Record<string, string | number>>;
  series: SeriesSpec[];
  xKey?: string;
  height?: number;
  horizontal?: boolean;
}) {
  const pesoData = data.map((row) => {
    const out: Record<string, string | number> = { [xKey]: row[xKey] };
    for (const s of series) out[s.key] = toPesos(Number(row[s.key] ?? 0));
    return out;
  });

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart
        data={pesoData}
        layout={horizontal ? 'vertical' : 'horizontal'}
        margin={{ top: 8, right: 12, bottom: 0, left: horizontal ? 8 : 4 }}
        barGap={2}
      >
        <CartesianGrid stroke={CHART_CHROME.grid} vertical={horizontal} horizontal={!horizontal} />
        {horizontal ? (
          <>
            <XAxis
              type="number"
              tick={AXIS_STYLE}
              tickLine={false}
              axisLine={false}
              tickFormatter={compactPeso}
            />
            <YAxis
              type="category"
              dataKey={xKey}
              tick={AXIS_STYLE}
              tickLine={false}
              axisLine={{ stroke: CHART_CHROME.grid }}
              width={140}
            />
          </>
        ) : (
          <>
            <XAxis
              dataKey={xKey}
              tick={AXIS_STYLE}
              tickLine={false}
              axisLine={{ stroke: CHART_CHROME.grid }}
            />
            <YAxis
              tick={AXIS_STYLE}
              tickLine={false}
              axisLine={false}
              tickFormatter={compactPeso}
              width={54}
            />
          </>
        )}
        <Tooltip content={<TooltipBox />} cursor={{ fill: 'rgba(148,163,184,0.08)' }} />
        {series.length > 1 && (
          <Legend
            iconType="square"
            iconSize={9}
            wrapperStyle={{ fontSize: 11, color: CHART_CHROME.text, paddingTop: 8 }}
          />
        )}
        {series.map((s, i) => (
          <Bar
            key={s.key}
            dataKey={s.key}
            name={s.label}
            fill={SERIES_ORDER[i % SERIES_ORDER.length]}
            radius={horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]}
            maxBarSize={horizontal ? 18 : 36}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

/**
 * Aging buckets. One measure across ordered categories, so a sequential ramp
 * in a single hue rather than four unrelated colours - the ordering is the
 * information.
 */
export function AgingChart({
  data,
  height = 200,
}: {
  data: Array<{ label: string; amount: Centavos }>;
  height?: number;
}) {
  const pesoData = data.map((d) => ({ label: d.label, amount: toPesos(d.amount) }));

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={pesoData} margin={{ top: 8, right: 8, bottom: 0, left: 4 }}>
        <CartesianGrid stroke={CHART_CHROME.grid} vertical={false} />
        <XAxis dataKey="label" tick={AXIS_STYLE} tickLine={false} axisLine={{ stroke: CHART_CHROME.grid }} />
        <YAxis tick={AXIS_STYLE} tickLine={false} axisLine={false} tickFormatter={compactPeso} width={54} />
        <Tooltip content={<TooltipBox />} cursor={{ fill: 'rgba(148,163,184,0.08)' }} />
        <Bar dataKey="amount" name="Amount" radius={[4, 4, 0, 0]} maxBarSize={44}>
          {pesoData.map((_, i) => (
            <Cell key={i} fill={SEQUENTIAL_BLUE[Math.min(i, SEQUENTIAL_BLUE.length - 1)]} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/**
 * Budget utilisation meter.
 *
 * A single proportion is a bar, not a chart: one rule with the figure beside
 * it reads faster than any plotted alternative. It turns amber past 90% and
 * red past 100%, because an over-utilised appropriation is a condition to act
 * on, not a value to admire.
 */
export function UtilizationMeter({
  used,
  total,
  label,
}: {
  used: Centavos;
  total: Centavos;
  label?: string;
}) {
  const ratio = total > 0 ? used / total : 0;
  const pct = Math.min(ratio, 1.5);
  const tone =
    ratio > 1 ? 'bg-rose-600' : ratio > 0.9 ? 'bg-amber-500' : 'bg-brand-600';

  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-xs text-slate-600">{label ?? 'Utilisation'}</span>
        <span className="font-mono text-sm font-medium tabular text-navy-900">
          {(ratio * 100).toFixed(1)}%
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-slate-200">
        <div
          className={`h-full rounded-full ${tone} transition-all`}
          style={{ width: `${Math.min(pct * 100, 100)}%` }}
          role="meter"
          aria-valuenow={Math.round(ratio * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={label ?? 'Budget utilisation'}
        />
      </div>
      <p className="mt-1 text-2xs text-slate-500">
        {formatPeso(used)} of {formatPeso(total)}
      </p>
    </div>
  );
}
