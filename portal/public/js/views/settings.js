import {h, icon, api, state, bus, card, toast, openDialog, confirmAction, toggle} from '../core.js';
import {prefs, savePrefs, chime} from '../notifications.js';
import {canInstall, install, standalone, isIos, pushSupported, pushState, enablePush, disablePush} from '../push.js';

export const meta = {title: 'Settings', description: 'Your app, notifications, alerts, profile and security.'};
let root;

function row(title, text, control) {
  return h('div', {class: 'setting-row'}, h('div', {}, h('strong', {text: title}), text ? h('small', {}, text) : null), control);
}
async function saveServer(changes) {
  try { state.prefs = await api('/api/prefs', changes); }
  catch (error) { toast(error.message, true); }
}
function serverToggle(key, label) {
  return toggle(Boolean(state.prefs?.[key]), event => saveServer({[key]: event.target.checked}), label);
}
function select(value, options, onchange, label) {
  const node = h('select', {'aria-label': label, class: 'compact-select', onchange: event => onchange(event.target.value)},
    options.map(([v, t]) => h('option', {value: String(v), text: t})));
  node.value = String(value);
  return node;
}

function appCard() {
  let control;
  if (standalone()) control = h('span', {class: 'pill good'}, icon('check'), 'Installed');
  else if (canInstall()) control = h('button', {class: 'btn primary', type: 'button', onclick: async () => { if (await install()) toast('Installed. Find Assistente IA on your home screen.'); render(); }}, icon('download'), 'Install app');
  else control = h('span', {class: 'pill', text: isIos() ? 'Use Share › Add to Home Screen' : window.isSecureContext ? 'Use the browser menu › Install' : 'Needs HTTPS'});
  return card('App', 'Install Assistente IA on this phone or computer', null, h('div', {},
    row('Install as an app', window.isSecureContext
      ? 'Opens full screen from your home screen or taskbar, like a native app.'
      : ['Installing needs a secure address. Open your remote HTTPS address (Devices › Use it anywhere).'], control)));
}

async function notificationCard() {
  const status = await pushState();
  const labels = {on: 'On for this device', off: 'Off on this device', blocked: 'Blocked by the browser', unsupported: window.isSecureContext ? 'Not supported by this browser' : 'Needs HTTPS'};
  const pushToggle = status === 'unsupported' || status === 'blocked'
    ? h('span', {class: 'pill warn', text: labels[status]})
    : toggle(status === 'on', async event => {
      const target = event.target;
      target.disabled = true;
      try {
        if (target.checked) { await enablePush(); toast('Push notifications are on for this device.'); }
        else { await disablePush(); toast('Push notifications are off for this device.'); }
      } catch (error) { target.checked = !target.checked; toast(error.message, true); }
      finally { target.disabled = false; render(); }
    }, 'Push notifications on this device');
  return card('Notifications', 'Push reaches this device even when Assistente IA is closed', null, h('div', {},
    row('Push on this device', [labels[status] + '. ', isIos() && !standalone() ? 'On iPhone, install the app first.' : ''], pushToggle),
    status === 'on' ? row('Send a test', 'Check that notifications arrive on every device you turned on.',
      h('button', {class: 'btn sm', type: 'button', onclick: async () => {
        try { await api('/api/push/test', {}); toast('Test sent. It should arrive in a few seconds.'); }
        catch (error) { toast(error.message, true); }
      }}, icon('bell'), 'Send test')) : null,
    h('p', {class: 'setting-group', text: 'Notify me about'}),
    row('Approval requests', 'An agent is waiting for Allow or Deny.', serverToggle('pushApprovals', 'Approval requests')),
    row('Finished tasks', 'A working session became idle.', serverToggle('pushFinished', 'Finished tasks')),
    row('Usage alerts', 'A limit crossed your alert level.', serverToggle('pushQuota', 'Usage alerts')),
    row('Daily summary', 'Your day with your agents.', serverToggle('pushSummary', 'Daily summary')),
    h('p', {class: 'setting-group', text: 'While the portal is open'}),
    row('Sound', 'A short chime for new requests and alerts.', h('div', {class: 'card-actions'},
      h('button', {class: 'btn ghost sm', type: 'button', onclick: () => chime('approval')}, 'Play'),
      toggle(prefs.sound, event => savePrefs({sound: event.target.checked}), 'Sound')))));
}

function alertsCard() {
  const p = state.prefs || {};
  const hours = Array.from({length: 24}, (_, hour) => [hour, new Date(2000, 0, 1, hour).toLocaleTimeString(undefined, {hour: '2-digit', minute: '2-digit'})]);
  return card('Alerts and summary', null, null, h('div', {},
    row('Usage alert level', 'Warn me once per window when Claude Code or Codex reaches this share of a limit.',
      select(p.quotaAlert ?? 80, [[0, 'Off'], [50, '50%'], [70, '70%'], [80, '80%'], [90, '90%'], [95, '95%']], value => saveServer({quotaAlert: Number(value)}), 'Usage alert level')),
    row('Daily summary', 'Agent time, projects and approvals for the day. Shown in Insights.', serverToggle('dailySummary', 'Daily summary')),
    row('Summary time', 'When the day is wrapped up.', select(p.summaryHour ?? 19, hours, value => saveServer({summaryHour: Number(value)}), 'Summary time'))));
}

async function render() {
  const user = state.user;
  if (!state.prefs) state.prefs = await api('/api/prefs').catch(() => ({}));
  const profile = h('form', {class: 'form', onsubmit: async event => {
    event.preventDefault();
    const name = new FormData(event.target).get('name');
    try { const data = await api('/api/account/profile', {name}); user.name = data.name; bus.emit('user'); toast('Profile saved.'); }
    catch (error) { toast(error.message, true); }
  }},
  h('div', {class: 'field-row'}, h('label', {}, 'Display name', h('input', {name: 'name', value: user.name, maxlength: 60, required: true})),
    h('label', {}, 'Email', h('input', {value: user.email, readonly: true}))),
  h('div', {}, h('button', {class: 'btn primary', type: 'submit'}, 'Save profile')));
  const theme = h('div', {class: 'segmented', role: 'group', 'aria-label': 'Theme'}, [['system', 'System'], ['dark', 'Dark'], ['light', 'Light']].map(([value, label]) =>
    h('button', {type: 'button', 'aria-pressed': String(prefs.theme === value), onclick: () => { savePrefs({theme: value}); render(); }}, label)));

  root.replaceChildren(h('div', {class: 'settings'},
    appCard(), await notificationCard(), alertsCard(),
    card('Appearance', null, null, row('Theme', 'Follow your system or pick one.', theme)),
    card('Profile', null, null, profile),
    card('Security', null, null, h('div', {},
      row('Password', 'Changing it signs out your other browsers.', h('button', {class: 'btn', type: 'button', onclick: changePassword}, 'Change password')),
      row('Other sessions', 'Sign out every other browser using this account.', h('button', {class: 'btn', type: 'button', onclick: async () => {
        try { const {signedOut} = await api('/api/account/sessions', {}); toast(`Signed out ${signedOut} other session${signedOut === 1 ? '' : 's'}.`); }
        catch (error) { toast(error.message, true); }
      }}, icon('signout'), 'Sign out others')))),
    h('article', {class: 'card danger-zone'}, h('div', {class: 'card-head'}, h('div', {}, h('h2', {text: 'Delete account'}),
      h('p', {text: 'Removes your profile, devices, activity, insights and rules. This cannot be undone.'})),
    h('button', {class: 'btn danger', type: 'button', onclick: deleteAccount}, icon('trash'), 'Delete account')))));
}
async function changePassword() {
  const done = await openDialog('Change password', body => body.append(
    h('label', {}, 'Current password', h('input', {type: 'password', name: 'current', required: true, autocomplete: 'current-password'})),
    h('label', {}, 'New password', h('input', {type: 'password', name: 'password', required: true, minlength: 10, maxlength: 128, autocomplete: 'new-password'})),
    h('label', {}, 'Repeat new password', h('input', {type: 'password', name: 'repeat', required: true, minlength: 10, maxlength: 128, autocomplete: 'new-password'}))),
  {submit: 'Change password', onSubmit: values => {
    if (values.password !== values.repeat) throw new Error('The new passwords do not match.');
    return api('/api/account/password', {current: values.current, password: values.password});
  }});
  if (done) toast('Password changed.');
}
async function deleteAccount() {
  if (!await confirmAction('Delete your account?', 'All devices are disconnected and every record is erased.', 'Continue', true)) return;
  const done = await openDialog('Confirm with your password', body => body.append(
    h('label', {}, 'Password', h('input', {type: 'password', name: 'password', required: true, autocomplete: 'current-password'}))),
  {submit: 'Delete account', danger: true, onSubmit: values => api('/api/account/delete', {password: values.password})});
  if (done) { await disablePush().catch(() => {}); bus.emit('signedout'); }
}
bus.on('installable', () => { if (root && !root.hidden) render(); });
export function mount(section) { root = section; }
export function show() { render(); }
export function update() {}
