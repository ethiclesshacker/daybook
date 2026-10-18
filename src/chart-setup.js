// @ts-check
// ======================================================
// Chart.js, registered piece by piece.
//
// `chart.js/auto` registers every controller, scale, element and plugin the
// library ships — radar, polar area, bubble, scatter, the log scale, the
// title and subtitle plugins, decimation — and none of that is drawn
// anywhere in this app. What is drawn: line, bar and doughnut charts on
// category, linear and time axes, with area fills, a legend and tooltips.
//
// Imported only by the modules that draw a chart, so the library lands in
// those views' chunks and not on the critical path of the login screen.
// Adding a chart type means adding its controller here — Chart.js throws
// '"radar" is not a registered controller' rather than failing quietly.
// ======================================================

import {
  Chart,
  LineController, BarController, DoughnutController,
  LineElement, PointElement, BarElement, ArcElement,
  CategoryScale, LinearScale, TimeScale,
  Filler, Legend, Tooltip,
} from 'chart.js';
import 'chartjs-adapter-date-fns';   // required by the `type: 'time'` x-axes

Chart.register(
  LineController, BarController, DoughnutController,
  LineElement, PointElement, BarElement, ArcElement,
  CategoryScale, LinearScale, TimeScale,
  Filler, Legend, Tooltip,
);

/** A CSS custom property, resolved for a canvas (where `var()` never resolves). */
function token(name, fallback) {
  if (typeof document === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/** 12px floor, like the rest of the type scale: canvas text was 10.5–11px. */
export const CHART_FONT_SIZE = 12;

// ── Plugins ─────────────────────────────────────────────

/**
 * A label for a reference line. A dashed line at 2,000 with nothing on it is
 * a line the reader has to go and find the meaning of; set `refLabel` on the
 * dataset and its text is drawn at the right-hand end, just above the line.
 */
const referenceLabel = {
  id: 'referenceLabel',
  afterDatasetsDraw(chart) {
    const { ctx, chartArea } = chart;
    chart.data.datasets.forEach((dataset, index) => {
      if (!dataset.refLabel) return;
      const meta = chart.getDatasetMeta(index);
      if (meta.hidden || !meta.data.length) return;
      const last = meta.data[meta.data.length - 1];
      if (!last || !Number.isFinite(last.y)) return;
      ctx.save();
      ctx.font = `600 ${CHART_FONT_SIZE}px ${Chart.defaults.font.family}`;
      ctx.fillStyle = dataset.refLabelColor || token('--text-secondary', '#b4c0d0');
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      ctx.fillText(dataset.refLabel, chartArea.right - 4, Math.max(chartArea.top + CHART_FONT_SIZE + 2, last.y - 4));
      ctx.restore();
    });
  },
};

/**
 * The total in the hole of a doughnut. `options.plugins.centerTotal` is
 * `{ text, label }`: a figure, and the word under it.
 */
const centerTotal = {
  id: 'centerTotal',
  afterDraw(chart, _args, opts) {
    if (chart.config.type !== 'doughnut' || !opts?.text) return;
    const meta = chart.getDatasetMeta(0);
    const arc = meta?.data?.[0];
    if (!arc) return;
    const { x, y } = arc;
    const { ctx } = chart;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = token('--text-primary', '#f1f5f9');
    ctx.font = `700 ${CHART_FONT_SIZE + 6}px ${Chart.defaults.font.family}`;
    ctx.fillText(opts.text, x, opts.label ? y - 8 : y);
    if (opts.label) {
      ctx.fillStyle = token('--text-muted', '#8b9ab0');
      ctx.font = `500 ${CHART_FONT_SIZE}px ${Chart.defaults.font.family}`;
      ctx.fillText(opts.label, x, y + 12);
    }
    ctx.restore();
  },
};

Chart.register(referenceLabel, centerTotal);

// ── Defaults ────────────────────────────────────────────

Chart.defaults.color = token('--text-muted', '#8b9ab0');
Chart.defaults.borderColor = 'rgba(148,163,184,0.1)';
// The bundled face registers as 'Inter Variable' (@fontsource-variable), not
// 'Inter'. A canvas font string with only an unknown family falls back to
// the browser default — which is how every chart spent months quietly
// rendering its ticks in Times New Roman.
Chart.defaults.font.family = "'Inter Variable', Inter, system-ui, sans-serif";
Chart.defaults.font.size = CHART_FONT_SIZE;
// Straight segments between readings. A smoothed curve draws values nobody
// measured — a dip below the lowest resting heart rate, a peak between two
// days of eating — and the eye reads them as data.
Chart.defaults.elements.line.tension = 0;

export { Chart };
