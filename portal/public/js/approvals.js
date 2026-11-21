import {$, h, icon, api, bus, state, badge, toast, serverNow} from './core.js';
import {ruleDialog} from './views/rules.js';

const nodes = new Map();
const queued = new Map();

function remaining(item) {
  const seconds = Math.max(0, Math.round((item.expiresAt - serverNow()) / 1000));
  return seconds >= 60 ? Math.floor(seconds / 60) + 'm ' + String(seconds % 60).padStart(2, '0') + 's left' : seconds + 's left';
}
async function decide(item, choice) {
  // Hide the card at once; it stays hidden while the agent finishes, and comes back only if sending fails.
  queued.set(item.id, choice);
  render(state.data);
  try {
    await api('/api/approval', {id: item.id, choice});
    toast(choice === 'allow' ? 'Allowed. The agent continues.' : 'Denied. The agent was told no.');
  } catch (error) {
    queued.delete(item.id);
    render(state.data);
    toast(error.status === 410 ? 'This request was already answered.' : error.message, true);
  }
}
function actions(item) {
  const wrap = h('div', {class: 'approval-actions'});
  let armed = 0;
  const allow = h('button', {class: 'btn good sm', type: 'button'}, icon('check'), 'Allow once');
  allow.onclick = () => {
    if (Date.now() - armed < 4000) { allow.disabled = true; decide(item, 'allow'); return; }
    armed = Date.now();
    allow.lastChild.textContent = 'Tap to confirm';
    setTimeout(() => { if (allow.isConnected && !allow.disabled) allow.lastChild.textContent = 'Allow once'; }, 4000);
  };
  const deny = h('button', {class: 'btn danger sm', type: 'button', onclick: () => { deny.disabled = true; decide(item, 'deny'); }}, icon('x'), 'Deny');
  const always = h('button', {class: 'btn ghost sm', type: 'button', title: 'Create a rule for requests like this', onclick: async () => {
    const choice = await ruleDialog({request: item}, 'Save rule and answer');
    if (choice) decide(item, choice);
  }}, icon('rules'), 'Always…');
  wrap.append(allow, deny, always);
  return wrap;
}
function build(item) {
  const countdown = h('span', {class: 'countdown'});
  const node = h('div', {class: 'approval', role: 'group', 'aria-label': 'Approval request'},
    h('div', {class: 'approval-icon'}, icon('bell')),
    h('div', {class: 'approval-body'},
      h('div', {class: 'approval-meta'}, badge(item.source), item.project ? h('strong', {text: item.project}) : null,
        item.tool ? h('span', {class: 'pill', text: item.tool}) : null, countdown),
      h('div', {class: 'approval-code', text: item.detail || item.description || 'Review the request in your terminal.'})),
    actions(item));
  node.countdown = countdown;

  return node;
}
export function render(data) {
  const dock = $('approval-dock');
  const items = data?.online ? data.approvals.filter(a => a.kind === 'permission' && a.expiresAt > serverNow() && !queued.has(a.id)) : [];
  const ids = new Set(items.map(a => a.id));
  for (const [id, node] of nodes) if (!ids.has(id)) { node.remove(); nodes.delete(id); }
  const listed = new Set((data?.approvals || []).map(a => a.id));
  for (const id of queued.keys()) if (!listed.has(id)) queued.delete(id);
  for (const item of items) {
    let node = nodes.get(item.id);
    if (!node) { node = build(item); nodes.set(item.id, node); dock.append(node); }
    node.item = item;
    node.countdown.textContent = remaining(item);
  }
  const pending = items.length;
  for (const id of ['nav-approvals', 'tab-approvals']) { $(id).textContent = pending; $(id).hidden = !pending; }
}
setInterval(() => {
  for (const node of nodes.values()) {
    if (node.item) node.countdown.textContent = remaining(node.item);
    if (node.item && node.item.expiresAt <= serverNow()) render(state.data);
  }
}, 1000);
bus.on('dashboard', render);
bus.on('signout', () => { nodes.forEach(n => n.remove()); nodes.clear(); queued.clear(); });
