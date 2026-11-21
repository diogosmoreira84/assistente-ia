import {$, api, bus, state, closeDrawer, toast} from './core.js';
import {applyTheme} from './notifications.js';
import {registerWorker, disablePush} from './push.js';
import './approvals.js';
import * as overview from './views/overview.js';
import * as activity from './views/activity.js';
import * as insights from './views/insights.js';
import * as rules from './views/rules.js';
import * as github from './views/github.js';
import * as devices from './views/devices.js';
import * as downloads from './views/downloads.js';
import * as settings from './views/settings.js';
import * as about from './views/about.js';

applyTheme();
const VIEWS = {overview, activity, insights, rules, github, devices, downloads, settings, about};
let createMode = false, source = null, poll = null, retry = null, mounted = false;

/* Authentication */
function authMode(mode) {
  createMode = mode;
  $('name-field').hidden = !mode;
  $('name').required = mode;
  $('password').autocomplete = mode ? 'new-password' : 'current-password';
  $('password').minLength = mode ? 10 : 1;
  $('auth-title').textContent = mode ? 'Create your account' : 'Welcome back';
  $('auth-copy').textContent = mode ? 'One place for your coding agents, their limits and their requests.'
    : 'Sign in to watch your coding agents and answer their requests from anywhere.';
  $('auth-submit').textContent = mode ? 'Create account' : 'Sign in';
  $('sign-in-tab').setAttribute('aria-selected', String(!mode));
  $('create-tab').setAttribute('aria-selected', String(mode));
  $('auth-error').hidden = true;
}
$('sign-in-tab').onclick = () => authMode(false);
$('create-tab').onclick = () => authMode(true);
$('auth-form').onsubmit = async event => {
  event.preventDefault();
  const button = $('auth-submit');
  button.disabled = true;
  $('auth-error').hidden = true;
  try {
    await api(createMode ? '/api/signup' : '/api/login', {name: $('name').value, email: $('email').value, password: $('password').value});
    $('password').value = '';
    await enter();
  } catch (error) {
    $('auth-error').textContent = error.message;
    $('auth-error').hidden = false;
  } finally { button.disabled = false; }
};
function showAuth() {
  stopLive();
  state.user = null; state.data = null;
  bus.emit('signout');
  github.reset();
  $('app').hidden = true;
  $('auth').hidden = false;
  closeDrawer();
  authMode(false);
}
bus.on('signedout', showAuth);
bus.on('unauthorized', () => { if (state.user) { toast('Your session ended. Sign in again.', true); showAuth(); } });
$('sign-out').onclick = async () => {
  // A signed-out browser must stop receiving this account's notifications.
  await disablePush().catch(() => {});
  try { await api('/api/logout', {}); } catch { /* Signing out locally is enough. */ }
  showAuth();
};

function renderUser() {
  $('user-name').textContent = state.user.name;
  $('user-email').textContent = state.user.email;
  $('avatar').textContent = (state.user.name.trim()[0] || '?').toUpperCase();
  $('app-version').textContent = state.user.version ? 'v' + state.user.version : '';
}
bus.on('user', renderUser);

async function enter() {
  state.user = await api('/api/me');
  state.prefs = await api('/api/prefs').catch(() => null);
  renderUser();
  if (!mounted) {
    for (const [name, view] of Object.entries(VIEWS)) view.mount($('view-' + name));
    mounted = true;
  }
  $('auth').hidden = true;
  $('app').hidden = false;
  route();
  startLive();
}

/* Routing */
function route() {
  const name = location.hash.replace(/^#\/?/, '') || 'overview';
  const target = VIEWS[name] ? name : 'overview';
  if (state.view !== target) VIEWS[state.view]?.hide?.();
  state.view = target;
  const {title, description} = VIEWS[target].meta;
  $('view-title').textContent = title;
  $('view-description').textContent = description;
  for (const [key] of Object.entries(VIEWS)) $('view-' + key).hidden = key !== target;
  document.querySelectorAll('[data-view]').forEach(link => {
    if (link.dataset.view === target) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  });
  closeMenu();
  if (!state.user) return;
  VIEWS[target].show?.();
  if (state.data) VIEWS[target].update?.(state.data);
  $('content').scrollIntoView?.({block: 'start'});
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);

/* Live data: server-sent events, falling back to polling. */
function receive(data) {
  state.data = data;
  if (typeof data.now === 'number') state.skew = data.now * 1000 - Date.now();
  const pill = $('agent-status');
  pill.classList.toggle('online', Boolean(data.online));
  pill.lastChild.textContent = data.online ? (data.state?.host || 'Agent') + ' · online' : 'Agent offline';
  bus.emit('dashboard', data);
  VIEWS[state.view].update?.(data);
}
async function pollOnce() {
  try { receive(await api('/api/dashboard')); } catch (error) { if (error.status === 401) showAuth(); }
}
function startLive() {
  stopLive();
  pollOnce();
  if (!('EventSource' in window)) { poll = setInterval(pollOnce, 3000); return; }
  source = new EventSource('/api/events');
  source.addEventListener('dashboard', event => { $('live').classList.add('on'); receive(JSON.parse(event.data)); });
  source.addEventListener('signout', () => showAuth());
  source.onerror = () => {
    $('live').classList.remove('on');
    if (source?.readyState === EventSource.CLOSED) {
      source = null;
      if (!poll) poll = setInterval(pollOnce, 3000);
      retry = setTimeout(() => { if (state.user) startLive(); }, 15000);
    }
  };
}
function stopLive() {
  source?.close(); source = null;
  clearInterval(poll); poll = null;
  clearTimeout(retry);
  $('live').classList.remove('on');
}
bus.on('refresh', pollOnce);
bus.on('toast', message => toast(message));
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && state.user && !source) startLive(); });

/* Mobile menu and drawer */
function closeMenu() { $('rail').classList.remove('open'); $('scrim').hidden = true; }
$('more-button').onclick = () => { $('rail').classList.add('open'); $('scrim').hidden = false; };
$('scrim').onclick = closeMenu;
$('drawer-close').onclick = closeDrawer;
document.addEventListener('keydown', event => { if (event.key === 'Escape') { closeDrawer(); closeMenu(); } });

registerWorker();
enter().catch(() => { $('auth').hidden = false; authMode(false); });
