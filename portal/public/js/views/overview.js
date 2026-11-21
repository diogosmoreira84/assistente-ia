import {h, icon, api, state, badge, statusTag, empty, card, openDrawer, duration, ago, until, tokens, hours,
  fmtTime, serverNow, PROVIDERS, providerId} from '../core.js';
import {sparkline} from '../charts.js';
import {connectThisPc} from './devices.js';

let root, filter = 'active', today = null, todayFetched = 0;
const history = {cpu: [], memory: [], last: null};
const parts = {};

export const meta = {title: 'Overview', description: 'Live sessions, usage limits and requests from your coding agents.'};

export function mount(section) {
  root = section;
  parts.stats = h('div', {class: 'stats'});
  parts.sessions = h('div');
  parts.chips = h('div', {class: 'chips', role: 'group', 'aria-label': 'Filter sessions'});
  parts.quota = h('div', {class: 'quota'});
  parts.host = h('div');
  parts.offline = h('div');
  const sessionsCard = card('Sessions', 'Working and waiting now, or the last week under History', parts.chips, parts.sessions);
  root.replaceChildren(parts.offline, parts.stats,
    h('div', {class: 'overview-grid'}, h('div', {class: 'stack'}, sessionsCard),
      h('div', {class: 'stack'}, card('Usage limits', 'Marker shows where steady use would be now', null, parts.quota))));
  renderChips();
}

const isActive = s => s.status === 'busy' || s.status === 'waiting';
function renderChips() {
  const sessions = state.data?.online ? state.data.sessions : [];
  const counts = {active: sessions.filter(isActive).length, history: sessions.filter(s => !isActive(s)).length};
  parts.chips.replaceChildren(h('div', {class: 'segmented', role: 'group', 'aria-label': 'Sessions'},
    [['active', 'Active'], ['history', 'History']].map(([id, label]) => h('button', {type: 'button', 'aria-pressed': String(filter === id),
      onclick: () => { filter = id; showAll = false; renderChips(); update(state.data); }}, label, h('span', {class: 'seg-count', text: String(counts[id])})))));
}

async function refreshToday() {
  if (Date.now() - todayFetched < 60000) return;
  todayFetched = Date.now();
  try {
    const stats = await api('/api/stats?days=7');
    const last = stats.daily.at(-1);
    today = {claude: last.claude, codex: last.codex, week: stats.daily.reduce((sum, d) => sum + d.claude + d.codex, 0),
      approvals: stats.approvals};
    if (state.data) renderStats(state.data);
  } catch { /* The tile keeps its last value. */ }
}

function tile(iconName, label, value, sub, extra) {
  return h('div', {class: 'stat'}, h('span', {class: 'stat-label'}, icon(iconName), label),
    h('span', {class: 'stat-value', text: value}), sub ? (sub instanceof Node ? sub : h('span', {class: 'stat-sub', text: sub})) : null, extra || null);
}

function renderStats(data) {
  const sessions = data.online ? data.sessions : [];
  const busy = sessions.filter(s => s.status === 'busy').length;
  const waiting = sessions.filter(s => s.status === 'waiting').length;
  const pending = data.online ? data.approvals.filter(a => !a.decision && a.expiresAt > serverNow()).length : 0;
  const pc = data.online ? data.state?.pc : null;
  const cpu = typeof pc?.cpu === 'number' ? pc.cpu : null;
  const mem = pc?.ramTotalGb ? pc.ramUsedGb / pc.ramTotalGb * 100 : null;
  if (!pc) { history.cpu = []; history.memory = []; history.last = null; }
  else if (history.last !== data.updated) {
    if (cpu !== null) history.cpu = [...history.cpu, cpu].slice(-30);
    if (mem !== null) history.memory = [...history.memory, mem].slice(-30);
    history.last = data.updated;
  }
  const todayTotal = today ? today.claude + today.codex : null;
  parts.stats.replaceChildren(
    tile('bolt', 'Working now', data.online ? String(busy) : '—', data.online ? `${sessions.length} sessions tracked` : 'Agent offline'),
    tile('bell', 'Needs you', data.online ? String(pending + waiting && Math.max(pending, waiting)) : '—',
      pending ? `${pending} approval${pending > 1 ? 's' : ''} waiting` : waiting ? `${waiting} session${waiting > 1 ? 's' : ''} waiting` : 'Nothing pending'),
    tile('clock', 'Agent time today', todayTotal === null ? '—' : hours(todayTotal),
      today ? h('span', {class: 'split'}, h('span', {}, h('i', {class: 'key claude'}), hours(today.claude)),
        h('span', {}, h('i', {class: 'key codex'}), hours(today.codex)), h('span', {class: 'muted', text: hours(today.week) + ' this week'})) : 'Collecting'),
    tile('cpu', data.state?.host || 'Computer', cpu === null ? '—' : Math.round(cpu) + '% CPU',
      mem === null ? 'No reading' : `${pc.ramUsedGb.toFixed(1)} / ${pc.ramTotalGb.toFixed(1)} GB memory`, sparkline(history.cpu)));
}

function sessionCard(item) {
  const id = providerId(item.tool);
  const active = item.lastActive || item.startedAt;
  const runningFor = item.status === 'busy' && item.startedAt ? 'running ' + duration((serverNow() - item.startedAt) / 1000) : active ? ago(active) : '';
  const usedContext = item.lastInputTokens && item.contextWindow ? Math.min(100, item.lastInputTokens / item.contextWindow * 100) : null;
  return h('button', {class: 'session ' + (item.status || ''), type: 'button', onclick: () => details(item)},
    h('div', {class: 'session-top'}, statusTag(item.status), badge(item.tool, '')),
    h('div', {class: 'session-name', text: item.project || item.name || 'Untitled session'}),
    item.title || item.waitingFor ? h('div', {class: 'session-title', text: item.status === 'waiting' && item.waitingFor ? 'Waiting for ' + item.waitingFor : item.title}) : null,
    h('div', {class: 'session-meta'},
      item.model ? h('span', {}, icon('cpu'), item.model + (item.effort ? ' · ' + item.effort : '')) : null,
      runningFor ? h('span', {}, icon('clock'), runningFor) : null,
      typeof item.totalTokens === 'number' ? h('span', {}, icon('bolt'), tokens(item.totalTokens) + ' tokens') : null),
    usedContext !== null ? h('div', {class: 'context'},
      h('div', {class: 'context-row'}, h('span', {text: 'Context'}), h('span', {text: Math.round(usedContext) + '%'})),
      h('div', {class: 'meter ' + id}, h('span', {style: `width:${usedContext}%`}))) : null);
}

async function details(item) {
  const rows = [
    ['Agent', PROVIDERS[providerId(item.tool)]?.name || item.tool], ['Status', statusTag(item.status)],
    ['Project', item.project], ['Session', item.title || item.name], ['Waiting for', item.waitingFor],
    ['Model', item.model && item.model + (item.effort ? ' · ' + item.effort + ' effort' : '')],
    ['Started', item.startedAt && new Date(item.startedAt).toLocaleString()],
    ['Last active', (item.lastActive || null) && ago(item.lastActive)], ['Last tool', item.lastTool],
    ['Tokens', typeof item.totalTokens === 'number' && `${tokens(item.totalTokens)} total · ${tokens(item.inputTokens)} in · ${tokens(item.outputTokens)} out`],
    ['Context', item.lastInputTokens && item.contextWindow && `${tokens(item.lastInputTokens)} of ${tokens(item.contextWindow)}`]
  ].filter(([, value]) => value);
  const recent = h('div', {class: 'list'}, h('p', {class: 'muted small', text: 'Loading recent activity…'}));
  openDrawer(item.project || 'Session',
    h('dl', {class: 'kv'}, rows.map(([key, value]) => [h('dt', {text: key}), h('dd', {}, value)])),
    h('div', {}, h('h3', {text: 'Recent activity', style: 'margin-bottom:6px'}), recent));
  if (!item.project) { recent.replaceChildren(h('p', {class: 'muted small', text: 'No project to match.'})); return; }
  try {
    const {items} = await api('/api/logs?limit=10&project=' + encodeURIComponent(item.project));
    recent.replaceChildren(...(items.length ? items.map(log => h('div', {class: 'list-item'},
      h('span', {class: 'grow'}, h('span', {class: 'title', text: log.event}), log.detail ? h('span', {class: 'sub mono', text: log.detail}) : null),
      h('span', {class: 'muted small', text: fmtTime(log.time * 1000)}))) : [h('p', {class: 'muted small', text: 'No events for this project yet.'})]));
  } catch (error) { recent.replaceChildren(h('p', {class: 'muted small', text: error.message})); }
}

function renderSessions(data) {
  const rank = {waiting: 0, busy: 1, shell: 2, idle: 3, unknown: 4};
  const items = (data.online ? data.sessions : [])
    .filter(s => filter === 'active' ? isActive(s) : !isActive(s))
    .sort((a, b) => (rank[a.status] ?? 5) - (rank[b.status] ?? 5) || (b.lastActive || 0) - (a.lastActive || 0));
  if (!data.online) return parts.sessions.replaceChildren(empty('devices', 'No live data', 'Sessions appear here once a desktop agent is connected.'));
  if (!items.length) return parts.sessions.replaceChildren(filter === 'active'
    ? empty('overview', 'No agent is working right now', data.sessions.length ? 'Recent sessions are under History.' : 'Start Claude Code or Codex on your computer and it will show up here.')
    : empty('clock', 'No past sessions', 'Sessions from the last week appear here.'));
  const limit = showAll ? items.length : 8;
  const nodes = [h('div', {class: 'sessions'}, items.slice(0, limit).map(sessionCard))];
  if (items.length > 8) nodes.push(h('div', {style: 'display:flex;justify-content:center;margin-top:12px'},
    h('button', {class: 'btn ghost sm', type: 'button', onclick: () => { showAll = !showAll; renderSessions(state.data); }},
      showAll ? 'Show fewer' : `Show all ${items.length} sessions`)));
  parts.sessions.replaceChildren(...nodes);
}
let showAll = false;

function renderQuota(data) {
  const providers = data.online ? data.quotas : [];
  parts.quota.replaceChildren(...Object.keys(PROVIDERS).map(id => {
    const provider = providers.find(p => providerId(p.id) === id);
    const block = h('div', {class: 'quota-provider'},
      h('div', {class: 'quota-head'}, badge(id), provider?.plan ? h('span', {class: 'pill', text: provider.plan}) : null));
    if (!provider?.limits?.length) { block.append(h('p', {class: 'muted small', text: provider?.error || (data.online ? 'No usage reading yet.' : 'Connect an agent to read limits.')})); return block; }
    for (const limit of provider.limits) {
      const percent = Math.max(0, Math.min(100, Number(limit.percent) || 0));
      let expected = typeof limit.expectedPercent === 'number' ? limit.expectedPercent : null;
      if (expected === null && limit.resetsAt && limit.windowSec) {
        expected = Math.max(0, Math.min(100, 100 - (limit.resetsAt - serverNow()) / 1000 / limit.windowSec * 100));
      }
      const ahead = expected !== null && percent > expected + 10 && percent >= 25;
      const label = String(limit.label || 'Limit').replace(/5-hour(?: session)?/i, '5-hour window').replace(/^weekly$/i, 'Weekly');
      block.append(h('div', {class: 'quota-item'},
        h('div', {class: 'quota-line'}, h('span', {text: label}), h('strong', {text: Math.round(percent) + '%'})),
        h('div', {class: 'meter ' + id, role: 'meter', 'aria-valuenow': Math.round(percent), 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': label},
          h('span', {style: `width:${percent}%`}), expected !== null ? h('i', {class: 'pace', style: `left:${expected}%`, title: 'Steady pace'}) : null),
        h('div', {class: 'quota-foot'}, h('span', {text: limit.resetsAt ? 'Resets ' + until(limit.resetsAt) : ''}),
          ahead ? h('span', {class: 'ahead'}, icon('warning'), 'Ahead of pace') : expected !== null ? h('span', {text: 'On track'}) : null)));
    }
    return block;
  }));
}

function renderOffline(data) {
  if (data.online) return parts.offline.replaceChildren();
  const user = state.user;
  const action = user?.localAgent
    ? h('button', {class: 'btn primary', type: 'button', onclick: connectThisPc}, icon('link'), 'Connect this PC')
    : h('a', {class: 'btn primary', href: '#/devices'}, icon('devices'), 'Set up a desktop agent');
  parts.offline.replaceChildren(h('div', {class: 'hero-empty empty'}, icon('devices'),
    h('strong', {text: data.updated ? 'Your agent went offline' : 'Connect your computer'}),
    h('p', {text: data.updated ? `Last update ${ago(data.updated * 1000)}. Check that the desktop agent is running.`
      : 'Link the PC where Claude Code and Codex run to see live sessions, limits and approvals.'}), action));
}

export function update(data) {
  if (!root || !data) return;
  renderOffline(data); renderStats(data); renderChips(); renderSessions(data); renderQuota(data);
  refreshToday();
}
export function show() { todayFetched = 0; refreshToday(); }
