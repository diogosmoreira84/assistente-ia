import {h, svg, icon, PROVIDERS} from './core.js';

const SERIES = [['claude', PROVIDERS.claude.name], ['codex', PROVIDERS.codex.name]];

function roundedTop(x, y, w, hgt, r) {
  r = Math.min(r, w / 2, hgt);
  return `M${x},${y + hgt}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hgt}Z`;
}
function niceMax(value) {
  if (value <= 0) return 1;
  const step = 10 ** Math.floor(Math.log10(value));
  return [1, 2, 2.5, 5, 10].map(m => m * step).find(m => m >= value);
}
export function legend(items = SERIES) {
  return h('div', {class: 'legend'}, items.map(([id, label]) => h('span', {}, h('i', {class: 'key ' + id}), label)));
}
function tooltip(chart) {
  const tip = h('div', {class: 'tooltip', hidden: true});
  chart.append(tip);
  return {
    show(x, y, title, rows) {
      tip.replaceChildren(h('b', {text: title}), ...rows.map(([id, label, value]) =>
        h('div', {}, h('span', {}, id ? h('i', {class: 'key ' + id}) : null, label), h('strong', {text: value}))));
      tip.hidden = false;
      const width = chart.clientWidth;
      tip.style.left = Math.max(80, Math.min(width - 80, x)) + 'px';
      tip.style.top = y + 'px';
    },
    hide() { tip.hidden = true; }
  };
}
export function dataTable(headings, rows) {
  return h('details', {class: 'data-table'}, h('summary', {}, icon('table'), 'View as table'),
    h('div', {class: 'table-wrap'}, h('table', {},
      h('thead', {}, h('tr', {}, headings.map((label, i) => h('th', {class: i ? 'num' : '', scope: 'col', text: label})))),
      h('tbody', {}, rows.map(row => h('tr', {}, row.map((cell, i) => h('td', {class: i ? 'num' : '', text: cell}))))))));
}

/** Stacked daily bars, one segment per provider, with a per-column tooltip. */
export function stackedBars(rows, format) {
  const W = 720, H = 230, left = 44, bottom = 26, top = 10, right = 6;
  // Duration scale with four even ticks (5m, 10m, 15m, 30m, 1h…), never finer than 5 minutes.
  const peak = Math.max(...rows.map(r => r.claude + r.codex), 0);
  const max = [1200, 2400, 3600, 7200, 14400, 28800, 57600, 86400].find(m => m >= peak) || niceMax(peak);
  const plotH = H - top - bottom, plotW = W - left - right;
  const slot = plotW / rows.length, barW = Math.max(4, Math.min(38, slot * 0.62));
  const y = v => top + plotH - v / max * plotH;
  const chart = h('div', {class: 'chart'});
  const plot = svg('svg', {class: 'plot', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Daily agent time by provider'});
  for (let i = 0; i <= 4; i++) {
    const value = max * i / 4, yy = y(value);
    plot.append(svg('line', {class: i ? 'gridline' : 'baseline', x1: left, x2: W - right, y1: yy, y2: yy}),
      svg('text', {x: left - 8, y: yy + 4, 'text-anchor': 'end'}, format(value, true)));
  }
  const labelEvery = Math.ceil(rows.length / 10);
  const tip = tooltip(chart);
  rows.forEach((row, i) => {
    const x = left + slot * i + (slot - barW) / 2;
    const band = svg('rect', {class: 'hover-band', x: left + slot * i, y: top, width: slot, height: plotH, opacity: 0});
    plot.append(band);
    let base = 0;
    const visible = SERIES.filter(([id]) => row[id] > 0);
    visible.forEach(([id], index) => {
      const value = row[id];
      const y0 = y(base), y1 = y(base + value), gap = index < visible.length - 1 ? 0 : 0;
      const height = Math.max(1, y0 - y1 - (index > 0 ? 2 : 0) - gap);
      const yTop = y1;
      plot.append(index === visible.length - 1
        ? svg('path', {class: id, d: roundedTop(x, yTop, barW, height, 4)})
        : svg('rect', {class: id, x, y: yTop, width: barW, height}));
      base += value;
    });
    if (i % labelEvery === 0 || i === rows.length - 1) {
      plot.append(svg('text', {x: x + barW / 2, y: H - 8, 'text-anchor': 'middle'}, row.label));
    }
    const hit = svg('rect', {class: 'hit', x: left + slot * i, y: top, width: slot, height: plotH + bottom});
    hit.addEventListener('pointerenter', () => {
      band.setAttribute('opacity', 1);
      const rect = plot.getBoundingClientRect(), scale = rect.width / W;
      tip.show((x + barW / 2) * scale, y(row.claude + row.codex) * scale, row.title || row.label,
        [...SERIES.map(([id, label]) => [id, label, format(row[id])]), ['', 'Total', format(row.claude + row.codex)]]);
    });
    hit.addEventListener('pointerleave', () => { band.setAttribute('opacity', 0); tip.hide(); });
    plot.append(hit);
  });
  chart.prepend(plot);
  return chart;
}

/** Percent lines over time (0–100), one per series, with a crosshair. */
export function lineChart(series, {from, to}) {
  const W = 720, H = 210, left = 40, bottom = 26, top = 10, right = 10;
  const plotW = W - left - right, plotH = H - top - bottom;
  const x = t => left + (t - from) / Math.max(1, to - from) * plotW;
  const y = v => top + plotH - Math.max(0, Math.min(100, v)) / 100 * plotH;
  const chart = h('div', {class: 'chart'});
  const plot = svg('svg', {class: 'plot', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Usage limit over time'});
  for (const value of [0, 25, 50, 75, 100]) {
    plot.append(svg('line', {class: value ? 'gridline' : 'baseline', x1: left, x2: W - right, y1: y(value), y2: y(value)}),
      svg('text', {x: left - 8, y: y(value) + 4, 'text-anchor': 'end'}, value + '%'));
  }
  const ticks = 6;
  for (let i = 0; i <= ticks; i++) {
    const t = from + (to - from) * i / ticks;
    plot.append(svg('text', {x: x(t), y: H - 8, 'text-anchor': i === 0 ? 'start' : i === ticks ? 'end' : 'middle'},
      new Date(t).toLocaleDateString(undefined, {day: 'numeric', month: 'short'})));
  }
  for (const item of series) {
    if (!item.points.length) continue;
    const d = item.points.map(([t, v], i) => (i ? 'L' : 'M') + x(t).toFixed(1) + ',' + y(v).toFixed(1)).join('');
    plot.append(svg('path', {d, fill: 'none', class: 'line-' + item.id, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round'}));
    const [lt, lv] = item.points.at(-1);
    plot.append(svg('circle', {cx: x(lt), cy: y(lv), r: 4, class: item.id, stroke: 'var(--surface)', 'stroke-width': 2}));
  }
  const cross = svg('line', {class: 'crosshair', y1: top, y2: top + plotH, opacity: 0});
  const markers = series.map(item => svg('circle', {r: 4, class: item.id, stroke: 'var(--surface)', 'stroke-width': 2, opacity: 0}));
  plot.append(cross, ...markers);
  const tip = tooltip(chart);
  const hit = svg('rect', {class: 'hit', x: left, y: top, width: plotW, height: plotH});
  hit.addEventListener('pointermove', event => {
    const rect = plot.getBoundingClientRect(), scale = rect.width / W;
    const t = from + ((event.clientX - rect.left) / scale - left) / plotW * (to - from);
    const rows = [];
    let anchorY = H;
    series.forEach((item, index) => {
      const nearest = item.points.reduce((best, p) => !best || Math.abs(p[0] - t) < Math.abs(best[0] - t) ? p : best, null);
      if (!nearest) { markers[index].setAttribute('opacity', 0); return; }
      markers[index].setAttribute('cx', x(nearest[0])); markers[index].setAttribute('cy', y(nearest[1]));
      markers[index].setAttribute('opacity', 1);
      anchorY = Math.min(anchorY, y(nearest[1]));
      rows.push([item.id, item.label, Math.round(nearest[1]) + '%']);
    });
    const xx = Math.max(left, Math.min(W - right, (event.clientX - rect.left) / scale));
    cross.setAttribute('x1', xx); cross.setAttribute('x2', xx); cross.setAttribute('opacity', 1);
    tip.show(xx * scale, anchorY * scale, new Date(t).toLocaleString(undefined, {day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'}), rows);
  });
  hit.addEventListener('pointerleave', () => { cross.setAttribute('opacity', 0); markers.forEach(m => m.setAttribute('opacity', 0)); tip.hide(); });
  plot.append(hit);
  chart.prepend(plot);
  return chart;
}

/** Horizontal stacked bars rendered as HTML rows (names stay selectable and wrap-safe). */
export function horizontalBars(rows, format) {
  const max = Math.max(...rows.map(r => r.claude + r.codex), 1);
  return h('div', {class: 'chart'}, rows.map(row => {
    const total = row.claude + row.codex;
    const title = `${row.project}: ${SERIES.map(([id, label]) => label + ' ' + format(row[id])).join(', ')}`;
    return h('div', {class: 'hbar', title},
      h('span', {class: 'hbar-name', text: row.project}),
      h('div', {class: 'hbar-track', style: `width:${Math.max(2, total / max * 100)}%`},
        SERIES.filter(([id]) => row[id] > 0).map(([id]) => h('span', {class: id, style: `flex:${row[id]}`}))),
      h('span', {class: 'hbar-value', text: format(total)}));
  }));
}

/** Small single-series sparkline for stat tiles. */
export function sparkline(values, color = 'var(--accent)') {
  const W = 200, H = 30;
  const node = svg('svg', {class: 'spark', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', 'aria-hidden': 'true'});
  if (values.length < 2) return node;
  const step = W / 29;
  const pts = values.map((v, i) => [W - (values.length - 1 - i) * step, H - 3 - Math.max(0, Math.min(100, v)) / 100 * (H - 6)]);
  node.append(svg('path', {d: pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(''),
    fill: 'none', stroke: color, 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke', 'stroke-linejoin': 'round'}));
  return node;
}
