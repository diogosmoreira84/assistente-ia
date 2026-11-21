// Installable app and push notifications.
import {api, bus} from './core.js';

let installPrompt = null;
export const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
export const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
export const pushSupported = () => window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

export async function registerWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return null;
  try { return await navigator.serviceWorker.register('/sw.js', {scope: '/'}); }
  catch (error) { console.warn('Service worker unavailable', error); return null; }
}
window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); installPrompt = event; bus.emit('installable', true); });
window.addEventListener('appinstalled', () => { installPrompt = null; bus.emit('installable', false); });
export const canInstall = () => Boolean(installPrompt);
export async function install() {
  if (!installPrompt) return false;
  installPrompt.prompt();
  const {outcome} = await installPrompt.userChoice;
  installPrompt = null;
  bus.emit('installable', false);
  return outcome === 'accepted';
}

function keyBytes(base64) {
  const raw = atob(base64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - base64.length % 4) % 4));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}
export async function pushState() {
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  const registration = await navigator.serviceWorker.getRegistration('/');
  const subscription = await registration?.pushManager.getSubscription();
  return subscription ? 'on' : 'off';
}
export async function enablePush() {
  if (!pushSupported()) throw new Error('This browser cannot receive push notifications here. Open the portal over HTTPS.');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notifications are blocked. Allow them in the browser or phone settings.');
  const registration = await registerWorker() || await navigator.serviceWorker.ready;
  await navigator.serviceWorker.ready;
  const {key} = await api('/api/push/key');
  let subscription = await registration.pushManager.getSubscription();
  if (subscription && subscription.options?.applicationServerKey) {
    const current = new Uint8Array(subscription.options.applicationServerKey);
    if (current.join() !== keyBytes(key).join()) { await subscription.unsubscribe(); subscription = null; }
  }
  subscription ||= await registration.pushManager.subscribe({userVisibleOnly: true, applicationServerKey: keyBytes(key)});
  await api('/api/push/subscribe', {endpoint: subscription.endpoint});
  localStorage.setItem('assistente.push', '1');
}
export async function disablePush() {
  const registration = await navigator.serviceWorker.getRegistration('/');
  const subscription = await registration?.pushManager.getSubscription();
  if (subscription) {
    await api('/api/push/unsubscribe', {endpoint: subscription.endpoint}).catch(() => {});
    await subscription.unsubscribe();
  }
  localStorage.removeItem('assistente.push');
}
export const pushActive = () => localStorage.getItem('assistente.push') === '1';
