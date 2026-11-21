import {h, icon, api, state, empty, card, toast, openDrawer, hours, PROVIDERS} from '../core.js';
import {stackedBars, lineChart, horizontalBars, legend, dataTable} from '../charts.js';

export const meta = {title: 'Insights', description: 'How much your agents work, where, and how fast you use your limits.'};
let root, range = '7', body;

export function mount(section) {
  root = section;
  body = h('div', {class: 'view'});
  root.replaceChildren(body);
}
function rangeControl() {
  return h('div', {class: 'segmented', role: 'group', 'aria-label': 'Time range'},
    [['7', 'Last 7 days'], ['30', 'Last 30 days']].map(([value, label]) => h('button', {type: 'button', 'aria-pressed': String(range === value),
      onclick: () => { range = value; load(); }}, label)));
}
function stat(label, value, sub) {
  return h('div', {class: 'stat'}, h('span', {class: 'stat-label', text: label}), h('span', {class: 'stat-value', text: value}),
    sub ? h('span', {class: 'stat-sub', text: sub}) : null);
}
async function load() {
  try {
    const [stats, summaries] = await Promise.all([api('/api/stats?days=' + range), api('/api/summaries').catch(() => ({items: []}))]);
    render(stats);
    body.insertBefore(summaryCard(summaries.items), body.children[2] || null);
  } catch (error) { body.replaceChildren(empty('warning', 'Could not load insights', error.message)); }
}

function dayName(day) {
  const date = new Date(day + 'T12:00:00'), today = new Date();
  const diff = Math.round((new Date(today.toDateString()) - new Date(date.toDateString())) / 86400000);
  return diff === 0 ? 'Today' : diff === 1 ? 'Yesterday' : date.toLocaleDateString(undefined, {weekday: 'long', day: 'numeric', month: 'short'});
}
function summaryDetail(summary) {
  const a = summary.approvals || {};
  return h('div', {class: 'summary'},
    h('div', {class: 'summary-stats'},
      [['Agent time', hours(summary.total)], [PROVIDERS.claude.name, hours(summary.seconds?.claude || 0)], [PROVIDERS.codex.name, hours(summary.seconds?.codex || 0)],
        ['Sessions started', String(summary.sessionsStarted || 0)], ['Allowed', String(a.allow || 0)], ['Blocked', String(a.deny || 0)], ['By rules', String(a.auto || 0)]]
        .map(([label, value]) => h('div', {}, h('span', {class: 'muted small', text: label}), h('strong', {text: value})))),
    summary.projects?.length ? h('div', {}, h('span', {class: 'muted small', text: 'Projects'}),
      h('div', {class: 'chips', style: 'margin-top:6px'}, summary.projects.map(p => h('span', {class: 'pill', text: `${p.project} · ${hours(p.seconds)}`})))) : null,
    summary.peaks?.length ? h('div', {}, h('span', {class: 'muted small', text: 'Highest usage'}),
      h('div', {class: 'chips', style: 'margin-top:6px'}, summary.peaks.map(p => h('span', {class: 'pill' + (p.percent >= 80 ? ' warn' : ''),
        text: `${PROVIDERS[p.provider]?.name || p.provider} ${String(p.label).toLowerCase()} ${p.percent}%`})))) : null);
}
function summaryCard(items) {
  const latest = items[0];
  const preview = h('button', {class: 'btn sm', type: 'button', onclick: async () => {
    try {
      const today = await api('/api/summaries/now', {});
      openDrawer('Today so far', h('p', {class: 'summary-headline', text: today.headline}), summaryDetail(today));
    } catch (error) { toast(error.message, true); }
  }}, icon('clock'), 'Today so far');
  if (!latest) {
    return card('Daily summary', 'A wrap-up of each day, at the time you choose in Settings', preview,
      empty('clock', 'No summaries yet', `Your first summary arrives today at ${String(state.prefs?.summaryHour ?? 19).padStart(2, '0')}:00.`));
  }
  return card('Daily summary', 'A wrap-up of each day, at the time you choose in Settings', preview,
    h('div', {class: 'summary-latest'}, h('span', {class: 'muted small', text: dayName(latest.day)}), h('p', {class: 'summary-headline', text: latest.headline}), summaryDetail(latest)),
    items.length > 1 ? h('div', {class: 'list', style: 'margin-top:10px'}, items.slice(1, 8).map(item => h('button', {class: 'list-item summary-row', type: 'button',
      onclick: () => openDrawer(dayName(item.day), h('p', {class: 'summary-headline', text: item.headline}), summaryDetail(item))},
    h('span', {class: 'grow'}, h('span', {class: 'title', text: dayName(item.day)}), h('span', {class: 'sub', text: item.headline})), icon('arrow')))) : null);
}
function render(stats) {
  const total = stats.daily.reduce((sum, d) => sum + d.claude + d.codex, 0);
  const claude = stats.daily.reduce((sum, d) => sum + d.claude, 0);
  const activeDays = stats.daily.filter(d => d.claude + d.codex > 60).length;
  const a = stats.approvals;
  const answered = a.allow + a.deny;
  const rows = stats.daily.map(d => {
    const date = new Date(d.day + 'T12:00:00');
    return {...d, label: date.toLocaleDateString(undefined, stats.days === 7 ? {weekday: 'short'} : {day: 'numeric', month: 'short'}),
      title: date.toLocaleDateString(undefined, {weekday: 'long', day: 'numeric', month: 'long'})};
  });
  const now = Date.now(), from = now - stats.days * 86400000;
  const quotaGroups = {};
  for (const series of stats.quota) {
    const kind = /week/i.test(series.label) ? 'Weekly limit' : '5-hour window';
    (quotaGroups[kind] ||= []).push({id: series.provider, label: PROVIDERS[series.provider]?.name || series.provider,
      points: series.points.map(([t, v]) => [t * 1000, v])});
  }
  const header = h('div', {class: 'card-head', style: 'margin:0'}, h('div'), rangeControl());
  body.replaceChildren(header,
    h('div', {class: 'stats'},
      stat('Agent time', hours(total), total ? `${Math.round(claude / total * 100)}% Claude Code · ${Math.round((total - claude) / total * 100)}% Codex` : 'No work recorded yet'),
      stat('Active days', `${activeDays} / ${stats.days}`, activeDays ? hours(total / activeDays) + ' per active day' : '—'),
      stat('Sessions started', String(stats.sessionsStarted), 'From session status changes'),
      stat('Approvals answered', String(answered), a.requested ? `${a.allow} allowed · ${a.deny} denied · ${a.auto} by rules` : 'No requests yet')),
    card('Agent time per day', 'Time sessions spent working, by agent', legend(),
      total ? [stackedBars(rows, (v, axis) => axis ? (v >= 3600 ? (v / 3600).toFixed(v % 3600 ? 1 : 0) + 'h' : Math.round(v / 60) + 'm') : hours(v)),
        dataTable(['Day', PROVIDERS.claude.name, PROVIDERS.codex.name, 'Total'], rows.map(r => [r.title, hours(r.claude), hours(r.codex), hours(r.claude + r.codex)]))]
        : empty('insights', 'No working time yet', 'Agent time is recorded while the portal receives updates from your desktop agent.')),
    h('div', {class: 'grid-2'},
      card('Top projects', 'Where your agents spent the most time', legend(),
        stats.projects.length ? [horizontalBars(stats.projects, hours),
          dataTable(['Project', PROVIDERS.claude.name, PROVIDERS.codex.name], stats.projects.map(p => [p.project, hours(p.claude), hours(p.codex)]))]
          : empty('repo', 'No projects yet')),
      card('Approvals', 'How requests were answered', null, approvalBreakdown(a))),
    ...Object.entries(quotaGroups).map(([title, series]) => card(title, 'Recorded every 5 minutes while the agent is online', legend(series.map(s => [s.id, s.label])),
      lineChart(series, {from, to: now}),
      dataTable(['Agent', 'Latest', 'Peak'], series.map(s => [s.label, Math.round(s.points.at(-1)?.[1] ?? 0) + '%', Math.round(Math.max(0, ...s.points.map(p => p[1]))) + '%'])))));
  if (!stats.quota.length) body.append(card('Usage limits over time', null, null, empty('insights', 'No samples yet', 'Limit readings are stored every 5 minutes while your agent is online.')));
}
function approvalBreakdown(a) {
  const rows = [['Requested', a.requested, ''], ['Allowed', a.allow, 'good'], ['Denied', a.deny, 'bad'], ['Answered by rules', a.auto, 'accent']];
  const max = Math.max(1, ...rows.map(r => r[1]));
  return h('div', {class: 'list'}, rows.map(([label, value, tone]) => h('div', {class: 'list-item'},
    h('span', {class: 'grow'}, h('span', {class: 'title', text: label}),
      h('div', {class: 'meter', style: 'margin-top:6px'}, h('span', {style: `width:${value / max * 100}%;background:var(--${tone || 'text-2'})`}))),
    h('strong', {text: String(value), style: 'font-variant-numeric:tabular-nums;min-width:32px;text-align:right'}))));
}
export function show() { load(); }
export function update() {}
