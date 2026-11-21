import {h, icon, api, badge, empty, toast, confirmAction, fmtTime, PROVIDERS, providerId} from '../core.js';

export const meta = {title: 'Activity', description: 'Everything your agents did over the last 30 days.'};
let root, list, more, filters = {q: '', agent: '', kind: '', project: ''}, items = [], projects = [], timer;
const KIND_ICON = {session: 'activity', approval: 'bell', rule: 'rules', device: 'devices', alert: 'warning', summary: 'clock'};

export function mount(section) {
  root = section;
  const search = h('input', {type: 'search', placeholder: 'Search events, projects and commands', 'aria-label': 'Search',
    oninput: event => { clearTimeout(timer); timer = setTimeout(() => { filters.q = event.target.value.trim(); load(); }, 250); }});
  const select = (key, label, options) => h('select', {'aria-label': label, onchange: event => { filters[key] = event.target.value; load(); }},
    options.map(([value, text]) => h('option', {value, text})));
  const projectSelect = select('project', 'Project', [['', 'All projects']]);
  projectSelect.id = 'activity-project';
  list = h('div');
  more = h('button', {class: 'btn', type: 'button', hidden: true, onclick: () => load(true)}, 'Load older events');
  root.replaceChildren(
    h('article', {class: 'card'},
      h('div', {class: 'card-head'}, h('div', {class: 'filters', style: 'flex:1'},
        h('div', {class: 'search'}, icon('search'), search),
        select('agent', 'Agent', [['', 'All agents'], ['claude', PROVIDERS.claude.name], ['codex', PROVIDERS.codex.name]]),
        select('kind', 'Event type', [['', 'All events'], ['session', 'Sessions'], ['approval', 'Approvals'], ['rule', 'Automation'], ['alert', 'Usage alerts'], ['summary', 'Daily summaries'], ['device', 'Devices']]),
        projectSelect),
      h('button', {class: 'btn ghost sm', type: 'button', onclick: clearAll}, icon('trash'), 'Clear all')),
      list, h('div', {style: 'display:flex;justify-content:center;margin-top:14px'}, more)));
}

function query(older) {
  const params = new URLSearchParams({limit: '50'});
  for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
  if (older && items.length) params.set('before', items.at(-1).id);
  return '/api/logs?' + params;
}
async function load(older = false) {
  try {
    const data = await api(query(older));
    items = older ? [...items, ...data.items] : data.items;
    more.hidden = !data.more;
    if (JSON.stringify(projects) !== JSON.stringify(data.projects)) {
      projects = data.projects;
      const select = root.querySelector('#activity-project');
      select.replaceChildren(h('option', {value: '', text: 'All projects'}), ...projects.map(p => h('option', {value: p, text: p})));
      select.value = filters.project;
    }
    render();
  } catch (error) { list.replaceChildren(empty('warning', 'Could not load activity', error.message)); }
}
function dayLabel(ms) {
  const day = new Date(ms); day.setHours(0, 0, 0, 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((today - day) / 86400000);
  return diff === 0 ? 'Today' : diff === 1 ? 'Yesterday' : day.toLocaleDateString(undefined, {weekday: 'long', day: 'numeric', month: 'long'});
}
function resultPill(item) {
  const value = item.result || '';
  if (!value) return null;
  const tone = /sent|connected|allow/i.test(value + item.event) && !/deny|denied/i.test(item.event) ? 'good'
    : /fail|expired|revoked|denied|deny/i.test(value + item.event) ? 'bad' : /waiting/i.test(value) ? 'warn' : '';
  return h('span', {class: 'pill ' + tone, text: value});
}
function render() {
  if (!items.length) {
    const filtered = Object.values(filters).some(Boolean);
    return list.replaceChildren(empty('activity', filtered ? 'No matching events' : 'No activity yet',
      filtered ? 'Try a different filter.' : 'Session changes, approvals and automation will be recorded here.'));
  }
  const nodes = [];
  let current = '';
  for (const item of items) {
    const label = dayLabel(item.time * 1000);
    if (label !== current) { nodes.push(h('div', {class: 'day-head', text: label})); current = label; }
    const known = Boolean(providerId(item.agent));
    nodes.push(h('div', {class: 'event'},
      h('span', {class: 'event-time', text: fmtTime(item.time * 1000)}),
      h('span', {class: 'event-icon ' + (item.kind || 'session')}, icon(KIND_ICON[item.kind] || 'activity')),
      h('div', {class: 'event-main'},
        h('div', {class: 'event-line'}, h('strong', {text: item.event}), known ? badge(item.agent) : item.agent ? h('span', {class: 'muted small', text: item.agent}) : null,
          item.project ? h('span', {class: 'muted', text: item.project}) : null, resultPill(item)),
        item.detail ? h('div', {class: 'event-detail', title: item.detail, text: item.detail}) : null),
      h('button', {class: 'icon-btn', type: 'button', 'aria-label': 'Delete event', title: 'Delete event', onclick: () => remove(item.id)}, icon('trash'))));
  }
  list.replaceChildren(...nodes);
}
async function remove(id) {
  try { await api('/api/logs/delete', {id}); items = items.filter(item => item.id !== id); render(); }
  catch (error) { toast(error.message, true); }
}
async function clearAll() {
  if (!await confirmAction('Clear all activity?', 'Every recorded event for this account will be deleted. Insights keep their totals.', 'Clear activity', true)) return;
  try { await api('/api/logs/delete', {id: 'all'}); items = []; render(); toast('Activity cleared.'); }
  catch (error) { toast(error.message, true); }
}
export function show() { load(); }
let lastRefresh = 0;
export function update() {
  // Refresh the newest page while the view is open, but not while the user browses older pages.
  if (root && !root.hidden && items.length <= 50 && Date.now() - lastRefresh > 10000) { lastRefresh = Date.now(); load(); }
}
