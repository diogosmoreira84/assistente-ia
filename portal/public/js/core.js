// Shared helpers. Every node is built with textContent; nothing user-controlled is parsed as HTML.
export const $ = id => document.getElementById(id);

export function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    // CSSOM writes are allowed by the strict CSP; style attributes are not.
    else if (key === 'style') {
      for (const rule of String(value).split(';')) {
        const at = rule.indexOf(':');
        if (at > 0) node.style.setProperty(rule.slice(0, at).trim(), rule.slice(at + 1).trim());
      }
    }
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, value);
  }
  append(node, children);
  return node;
}
function append(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}
const SVG = 'http://www.w3.org/2000/svg';
export function svg(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) continue;
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}
export const icon = (name, extra = '') => svg('svg', {class: extra, 'aria-hidden': 'true'}, svg('use', {href: '#i-' + name}));

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export async function api(path, body) {
  const options = body === undefined ? {} : {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)};
  let response;
  try { response = await fetch(path, options); }
  catch { throw new ApiError(0, 'The portal is unreachable. Check your connection.'); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && !['/api/me', '/api/login', '/api/signup'].includes(path)) bus.emit('unauthorized');
    throw new ApiError(response.status, data.error || 'Could not complete the request.');
  }
  return data;
}

// Tiny event bus and shared state.
const handlers = {};
export const bus = {
  on(name, fn) { (handlers[name] ||= new Set()).add(fn); return () => handlers[name].delete(fn); },
  emit(name, value) { (handlers[name] || []).forEach(fn => { try { fn(value); } catch (error) { console.error(error); } }); }
};
export const state = {user: null, data: null, view: 'overview', skew: 0};

export const PROVIDERS = {
  claude: {name: 'Claude Code', icon: '/assets/claude.svg', href: 'https://claude.com/product/claude-code'},
  codex: {name: 'Codex', icon: '/assets/codex.svg', href: 'https://openai.com/codex/'}
};
export function providerId(value) {
  const id = String(value || '').toLowerCase().replace(/[\s_-]/g, '');
  return id === 'claude' || id === 'claudecode' ? 'claude' : id === 'codex' ? 'codex' : '';
}
export function badge(value, label) {
  const provider = PROVIDERS[providerId(value)];
  return h('span', {class: 'provider'}, provider ? h('img', {src: provider.icon, alt: ''}) : null, label ?? provider?.name ?? (value || 'Agent'));
}
export const STATUS = {
  busy: ['Working', 'busy'], waiting: ['Needs you', 'waiting'], idle: ['Idle', 'idle'],
  unknown: ['Unknown', 'idle'], shell: ['Terminal open', 'idle']
};
export function statusTag(status) {
  const [label, dot] = STATUS[status] || STATUS.unknown;
  return h('span', {class: 'status'}, h('span', {class: 'dot ' + dot}), label);
}

// Time and number formatting.
export const serverNow = () => Date.now() + state.skew;
export function duration(seconds, short = false) {
  seconds = Math.max(0, Math.round(seconds));
  if (seconds < 60) return seconds + 's';
  const m = Math.floor(seconds / 60), hh = Math.floor(m / 60), d = Math.floor(hh / 24);
  if (d) return d + 'd ' + (hh % 24) + 'h';
  if (hh) return hh + 'h ' + String(m % 60).padStart(short ? 1 : 2, '0') + 'm';
  return m + 'm';
}
export function ago(ms) {
  const seconds = (serverNow() - ms) / 1000;
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return Math.round(seconds / 60) + 'm ago';
  if (seconds < 86400) return Math.round(seconds / 3600) + 'h ago';
  return Math.round(seconds / 86400) + 'd ago';
}
export function until(ms) {
  const seconds = (ms - serverNow()) / 1000;
  return seconds <= 0 ? 'now' : 'in ' + duration(seconds, true);
}
export const fmtTime = ms => new Date(ms).toLocaleTimeString(undefined, {hour: '2-digit', minute: '2-digit'});
export const fmtDate = ms => new Date(ms).toLocaleDateString(undefined, {day: 'numeric', month: 'short'});
export const fmtDateTime = ms => new Date(ms).toLocaleString(undefined, {day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'});
export function tokens(value) {
  if (typeof value !== 'number') return '—';
  return value >= 1e6 ? (value / 1e6).toFixed(1) + 'M' : value >= 1e3 ? Math.round(value / 1e3) + 'k' : String(value);
}
export const hours = seconds => seconds >= 3600 ? (seconds / 3600).toFixed(1) + 'h' : Math.round(seconds / 60) + 'm';

// Feedback.
export function toast(message, error = false) {
  const node = h('div', {class: 'toast' + (error ? ' error' : ''), role: error ? 'alert' : 'status'}, icon(error ? 'warning' : 'check'), message);
  $('toasts').append(node);
  setTimeout(() => node.remove(), error ? 6000 : 3500);
}
export function empty(iconName, title, text, action) {
  return h('div', {class: 'empty'}, icon(iconName), h('strong', {text: title}), text ? h('p', {text}) : null, action || null);
}
export function card(title, subtitle, actions, ...body) {
  return h('article', {class: 'card'},
    h('div', {class: 'card-head'}, h('div', {}, h('h2', {text: title}), subtitle ? h('p', {text: subtitle}) : null),
      actions ? h('div', {class: 'card-actions'}, actions) : null),
    body);
}

/**
 * Opens the shared dialog. `build(body)` fills it. On confirm, `onSubmit(values)` runs; if it throws, the error is
 * shown and the dialog stays open. Resolves with onSubmit's result (or true), or null when cancelled.
 */
export function openDialog(title, build, {submit = 'Confirm', danger = false, cancel = 'Cancel', onSubmit} = {}) {
  const dialog = $('dialog'), form = $('dialog-form');
  if (dialog.open) dialog.close();
  form.replaceChildren(h('h2', {text: title}));
  const error = h('p', {class: 'form-error', role: 'alert', hidden: true});
  const body = h('div', {class: 'form'});
  build(body);
  const confirm = h('button', {class: 'btn ' + (danger ? 'danger solid' : 'primary'), value: 'confirm', type: 'submit', text: submit});
  form.append(body, error, h('div', {class: 'dialog-actions'}, h('button', {class: 'btn', value: 'cancel', formnovalidate: true, type: 'submit', text: cancel}), confirm));
  return new Promise(resolve => {
    let done = false;
    const finish = value => { if (done) return; done = true; resolve(value); if (dialog.open) dialog.close(); };
    form.onsubmit = async event => {
      event.preventDefault();
      if (event.submitter?.value !== 'confirm') return finish(null);
      if (!onSubmit) return finish(true);
      confirm.disabled = true;
      error.hidden = true;
      try { finish((await onSubmit(Object.fromEntries(new FormData(form)))) ?? true); }
      catch (failure) { error.textContent = failure.message; error.hidden = false; }
      finally { confirm.disabled = false; }
    };
    dialog.onclose = () => finish(null);
    dialog.showModal();
    body.querySelector('input:not([readonly]),select,textarea')?.focus();
  });
}
export async function confirmAction(title, detail, submit = 'Confirm', danger = false) {
  return Boolean(await openDialog(title, body => body.append(h('p', {class: 'muted', style: 'white-space:pre-wrap', text: detail})), {submit, danger}));
}

export function openDrawer(title, ...content) {
  $('drawer-title').textContent = title;
  $('drawer-body').replaceChildren(...content);
  $('drawer').classList.add('open');
  $('drawer').setAttribute('aria-hidden', 'false');
  $('drawer').focus();
}
export function closeDrawer() {
  $('drawer').classList.remove('open');
  $('drawer').setAttribute('aria-hidden', 'true');
}
export async function copy(text, label = 'Copied') {
  try { await navigator.clipboard.writeText(text); toast(label + '.'); }
  catch { toast('Clipboard unavailable. Select the text and copy it manually.', true); }
}
export function toggle(checked, onchange, label) {
  return h('label', {class: 'switch', title: label}, h('input', {type: 'checkbox', checked, 'aria-label': label, onchange}), h('span'));
}
