import {h, icon, api, copy, PROVIDERS} from '../core.js';

export const meta = {title: 'Downloads', description: 'Install Assistente IA on your phone and computer.'};
let root;

/** The Android install block: a QR code the phone camera can open, plus a direct link. */
export async function androidInstall(compact = false) {
  const box = h('div', {class: 'install'}, h('p', {class: 'muted small', text: 'Preparing download…'}));
  try {
    const {android} = await api('/api/downloads/info');
    if (!android) { box.replaceChildren(h('p', {class: 'muted', text: 'The Android app is not available on this portal yet.'})); return box; }
    const size = (android.size / 1048576).toFixed(1) + ' MB';
    const parts = [];
    if (android.url && android.reachable) {
      parts.push(h('div', {class: 'qr'}, h('img', {src: android.qr, alt: 'QR code to download the Android app'}),
        h('p', {text: 'Point your phone camera here'})));
    } else if (android.url) {
      parts.push(h('div', {class: 'callout warn'}, icon('warning'), h('span', {},
        'The phone download service is not running. On this PC, run ', h('code', {text: 'python lan_download.py <LAN_IP>'}), ' and refresh.')));
    }
    parts.push(h('div', {class: 'install-steps'},
      h('ol', {class: 'steps'},
        h('li', {text: 'Scan the code with your phone camera and open the link.'}),
        h('li', {text: 'Tap Download, open the file and allow the install if Android asks.'}),
        h('li', {text: 'Open the app, tap Connect to PC and scan the pairing code in Devices.'})),
      compact ? null : h('div', {class: 'card-actions'},
        android.url ? h('button', {class: 'btn sm', type: 'button', onclick: () => copy(android.url, 'Link copied')}, icon('copy'), 'Copy phone link') : null,
        h('a', {class: 'btn ghost sm', href: '/downloads/android'}, icon('download'), 'Download on this device')),
      h('p', {class: 'hint', text: `${size} · Android 4.4+ · same Wi-Fi network as this PC`}),
      compact ? null : h('details', {class: 'data-table'}, h('summary', {text: 'Verify the file (SHA-256)'}), h('code', {class: 'hash', text: android.sha256}))));
    box.replaceChildren(...parts);
  } catch (error) { box.replaceChildren(h('p', {class: 'form-error', text: error.message})); }
  return box;
}

function item(iconNode, title, text, action, note) {
  return h('article', {class: 'card download'},
    h('div', {class: 'download-head'}, iconNode, h('h2', {text: title})),
    h('p', {class: 'muted', text}), note ? h('p', {class: 'hint', text: note}) : null, h('div', {}, action));
}
export function mount(section) { root = section; }
export async function show() {
  const file = (href, label = 'Download') => h('a', {class: 'btn primary', href}, icon('download'), label);
  const link = (href, label) => h('a', {class: 'btn', href, target: '_blank', rel: 'noopener noreferrer'}, label, icon('external'));
  const phone = h('article', {class: 'card phone-card'},
    h('div', {class: 'download-head'}, h('span', {class: 'setup-icon'}, icon('qr')),
      h('div', {}, h('h2', {text: 'Android app'}), h('p', {class: 'muted', text: 'Live dashboard and one-tap approvals on your phone or tablet.'}))),
    h('p', {class: 'muted small', text: 'Loading…'}));
  root.replaceChildren(phone,
    h('div', {class: 'grid-2'},
      item(h('span', {class: 'setup-icon'}, icon('devices')), 'Windows agent', 'Desktop agent, bundled Python and the portal connector for Windows x64.',
        file('/downloads/windows'), 'Extract the ZIP and run Install-AssistenteIA.cmd.'),
      item(h('span', {class: 'setup-icon'}, icon('link')), 'Portal connector', 'Relays any PhoneBox agent to this portal. Requires Python 3.10 or newer.',
        file('/downloads/connector'), 'Run: python connector.py --portal <portal address>')),
    h('h2', {text: 'Coding agents'}),
    h('div', {class: 'grid-2'}, Object.values(PROVIDERS).map(provider =>
      item(h('img', {src: provider.icon, alt: ''}), provider.name, 'Install it on your computer and sign in. Assistente IA reads its sessions through the desktop agent.',
        link(provider.href, 'Get ' + provider.name)))));
  phone.lastChild.replaceWith(await androidInstall());
}
export function update() {}
