import {bus, state, PROVIDERS, providerId} from './core.js';

const KEY = 'assistente.prefs';
const defaults = {notify: false, sound: true, onApproval: true, onFinished: true, theme: 'system'};
export const prefs = {...defaults, ...JSON.parse(localStorage.getItem(KEY) || '{}')};
export function savePrefs(changes) {
  Object.assign(prefs, changes);
  localStorage.setItem(KEY, JSON.stringify(prefs));
  if ('theme' in changes) applyTheme();
}
export function applyTheme() {
  const dark = prefs.theme === 'dark' || (prefs.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name=theme-color]').content = dark ? '#0f1014' : '#f5f6f8';
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

export const notificationsSupported = () => 'Notification' in window && window.isSecureContext;
export async function enableNotifications() {
  if (!notificationsSupported()) return 'unsupported';
  const result = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  savePrefs({notify: result === 'granted'});
  return result;
}

let audio;
export function chime(kind = 'approval') {
  if (!prefs.sound) return;
  try {
    audio ||= new AudioContext();
    const notes = kind === 'approval' ? [880, 1175] : [660, 880, 990];
    notes.forEach((frequency, i) => {
      const osc = audio.createOscillator(), gain = audio.createGain();
      const start = audio.currentTime + i * 0.13;
      osc.frequency.value = frequency;
      osc.type = 'sine';
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.18, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.22);
      osc.connect(gain).connect(audio.destination);
      osc.start(start); osc.stop(start + 0.25);
    });
  } catch { /* Audio is optional. */ }
}
function show(title, body, tag) {
  // When push is on, the service worker already shows the notification; avoid a duplicate.
  if (localStorage.getItem('assistente.push') === '1') return;
  if (!prefs.notify || !notificationsSupported() || Notification.permission !== 'granted') return;
  if (document.visibilityState === 'visible' && document.hasFocus()) return;
  const note = new Notification(title, {body, tag, icon: '/assets/logo.svg'});
  note.onclick = () => { window.focus(); location.hash = '#/overview'; note.close(); };
}

let seenApprovals = null, lastStatus = null;
bus.on('dashboard', data => {
  const pending = data.online ? data.approvals.filter(a => a.kind === 'permission' && !a.decision && a.expiresAt > Date.now() + state.skew) : [];
  document.title = (pending.length ? `(${pending.length}) ` : '') + 'Assistente IA';
  const ids = new Set(pending.map(a => a.id));
  if (seenApprovals) {
    const fresh = pending.filter(a => !seenApprovals.has(a.id));
    if (fresh.length && prefs.onApproval) {
      chime('approval');
      const first = fresh[0];
      show(`${PROVIDERS[providerId(first.source)]?.name || 'Agent'} needs approval`,
        [first.project, first.tool && first.tool + ': ' + (first.detail || '')].filter(Boolean).join(' · ').slice(0, 180), 'approval-' + first.id);
    }
  }
  seenApprovals = ids;
  const statuses = new Map(data.online ? data.sessions.map(s => [s.id, s]) : []);
  if (lastStatus && prefs.onFinished) {
    for (const [id, session] of statuses) {
      if (lastStatus.get(id) === 'busy' && session.status === 'idle') {
        chime('finished');
        show(`${session.project || 'Session'} finished`, `${PROVIDERS[providerId(session.tool)]?.name || 'Agent'} is idle and ready for you.`, 'done-' + id);
        break;
      }
    }
  }
  lastStatus = new Map([...statuses].map(([id, s]) => [id, s.status]));
  quotaAlerts(data);
});

// In-tab usage alerts mirror the server's push alerts, once per limit window.
function quotaAlerts(data) {
  const threshold = state.prefs?.quotaAlert || 0;
  if (!threshold || !data.online) return;
  const seen = JSON.parse(sessionStorage.getItem('assistente.quotaSeen') || '{}');
  for (const provider of data.quotas || []) {
    for (const limit of provider.limits || []) {
      const percent = Number(limit.percent);
      if (!(percent >= threshold)) continue;
      const key = [provider.id, limit.label, threshold, limit.resetsAt ? Math.round(limit.resetsAt / 3600000) : ''].join('|');
      if (seen[key]) continue;
      seen[key] = Date.now();
      const name = PROVIDERS[providerId(provider.id)]?.name || provider.id;
      const message = `${name} is at ${Math.round(percent)}% of its ${String(limit.label || '').toLowerCase()} limit.`;
      bus.emit('toast', message);
      chime('approval');
      show('Usage alert', message, 'quota-' + key);
    }
  }
  sessionStorage.setItem('assistente.quotaSeen', JSON.stringify(seen));
}
bus.on('signout', () => { seenApprovals = null; lastStatus = null; document.title = 'Assistente IA'; });
