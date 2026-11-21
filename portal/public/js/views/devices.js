import {h, icon, api, state, bus, empty, card, toast, confirmAction, copy, ago} from '../core.js';
import {androidInstall} from './downloads.js';

export const meta = {title: 'Devices', description: 'Link the computer that runs your agents and pair your phone or tablet.'};
let root, rows, keyBox, qrBox, qrTimer;

export async function connectThisPc() {
  if (!await confirmAction('Connect this PC?', `Coding sessions and approval requests on this PC will be linked to ${state.user.name}.`, 'Connect')) return;
  try {
    await api('/api/connect/local', {});
    state.user.localLinked = true;
    toast('This PC is linked. Live data arrives in a few seconds.');
    bus.emit('refresh');
    if (root && !root.hidden) render();
  } catch (error) { toast(error.message, true); }
}

export function mount(section) {
  root = section;
  rows = h('div', {class: 'list'});
  keyBox = h('div', {class: 'form', hidden: true});
  qrBox = h('div', {hidden: true});
}

function render() {
  const user = state.user;
  const local = user.localAgent ? h('div', {class: 'form'},
    user.localLinked ? h('div', {class: 'callout'}, icon('check'), h('span', {text: 'This PC is linked to your account and reconnects automatically.'}))
      : h('button', {class: 'btn primary', type: 'button', onclick: connectThisPc}, icon('link'), 'Connect this PC'),
    h('p', {class: 'hint', text: 'Uses the Claude Code and Codex sessions already running on this Windows PC.'})) : null;
  const agentForm = h('form', {class: 'form', onsubmit: generateKey},
    h('label', {}, 'Device name', h('input', {name: 'name', placeholder: 'Work laptop', maxlength: 60})),
    h('button', {class: 'btn' + (user.localAgent ? '' : ' primary'), type: 'submit'}, icon('bolt'), 'Generate agent key'));
  const remote = h('details', {open: !user.localAgent},
    h('summary', {class: 'muted small', style: 'cursor:pointer;margin-bottom:10px', text: user.localAgent ? 'Connect a different computer' : 'Connect a computer'}),
    h('div', {class: 'form'},
      h('ol', {class: 'steps'}, h('li', {text: 'Install the Windows agent from Downloads and sign in to Claude Code or Codex.'}),
        h('li', {text: 'Generate a key below. It is shown once.'}), h('li', {text: 'Run Connect-Portal and paste the portal address and key.'})),
      agentForm, keyBox));
  root.replaceChildren(
    h('div', {class: 'grid-2'},
      h('article', {class: 'card setup-card'}, h('span', {class: 'setup-icon'}, icon('devices')),
        h('div', {}, h('h2', {text: 'Desktop agent'}), h('p', {class: 'muted', text: 'The computer where your coding agents run.'})), local, remote),
      h('article', {class: 'card setup-card'}, h('span', {class: 'setup-icon'}, icon('qr')),
        h('div', {}, h('h2', {text: 'Phone or tablet'}), h('p', {class: 'muted', text: 'Pair the Android app with a one-time QR code.'})),
        h('ol', {class: 'steps'},
          h('li', {}, 'Install the app. ', h('button', {class: 'link-btn', type: 'button', onclick: async event => {
            event.target.disabled = true;
            event.target.closest('.setup-card').querySelector('.install-slot').replaceChildren(await androidInstall(true));
          }}, 'Show install code')),
          h('li', {text: 'Open it, tap Connect to PC and scan the pairing code.'}),
          h('li', {text: 'Confirm the account name on the device.'})),
        h('div', {class: 'install-slot'}),
        user.pairing ? h('button', {class: 'btn primary', type: 'button', onclick: newQr}, icon('qr'), 'Show pairing code')
          : h('div', {class: 'callout warn'}, icon('warning'), h('span', {text: 'Pairing needs the HTTPS listener. Start the portal with --pair-origin and --pair-cert.'})),
        qrBox)),
    remoteCard(),
    card('Connected devices', 'Revoke anything you no longer use', null, rows));
  loadDevices();
}

function remoteCard() {
  const slot = h('div', {class: 'install'}, h('p', {class: 'muted small', text: 'Checking…'}));
  const node = h('article', {class: 'card setup-card'},
    h('div', {class: 'download-head'}, h('span', {class: 'setup-icon'}, icon('link')),
      h('div', {}, h('h2', {text: 'Use it anywhere'}), h('p', {class: 'muted', text: 'Approve requests on mobile data, at work or on the road, and install the portal as an app.'}))),
    slot);
  api('/api/remote').then(remote => {
    if (remote.origin) {
      slot.replaceChildren(
        h('div', {class: 'qr'}, h('img', {src: remote.qr, alt: 'QR code with your remote portal address'}), h('p', {text: 'Scan with your phone'})),
        h('div', {class: 'install-steps'},
          h('div', {class: 'secret'}, h('input', {readonly: true, value: remote.origin, 'aria-label': 'Remote address'}),
            h('button', {class: 'btn', type: 'button', onclick: () => copy(remote.origin, 'Address copied')}, icon('copy'), 'Copy')),
          h('ol', {class: 'steps'},
            h('li', {text: 'Install Tailscale on your phone and sign in with the same account as this PC.'}),
            h('li', {text: 'Scan the code and sign in to Assistente IA.'}),
            h('li', {text: 'Install it: Android menu › Install app, or iPhone Share › Add to Home Screen.'}),
            h('li', {text: 'In Settings, turn on push notifications for that device.'})),
          h('p', {class: 'hint', text: 'Only devices in your private Tailscale network can open this address.'})));
    } else {
      slot.replaceChildren(h('div', {class: 'install-steps'},
        h('ol', {class: 'steps'},
          h('li', {}, 'Install ', h('a', {href: 'https://tailscale.com/download', target: '_blank', rel: 'noopener noreferrer', text: 'Tailscale'}), ' on this PC and your phone, signed in to the same account.'),
          h('li', {text: 'In the Tailscale admin console, open DNS and enable MagicDNS and HTTPS certificates.'}),
          h('li', {}, 'Restart the portal with ', h('code', {text: 'Start-Portal.ps1'}), '. It publishes the portal on your private Tailscale address.')),
        h('p', {class: 'hint', text: 'Nothing is opened to the internet: only your own devices can reach it.'})));
    }
  }).catch(error => slot.replaceChildren(h('p', {class: 'form-error', text: error.message})));
  return node;
}

async function generateKey(event) {
  event.preventDefault();
  const name = new FormData(event.target).get('name');
  if (!await confirmAction('Generate a new agent key?', 'Any agent already connected to this account will be disconnected.', 'Generate key')) return;
  try {
    const data = await api('/api/connect/agent', {name});
    state.user.localLinked = false;
    const input = h('input', {readonly: true, value: data.token, 'aria-label': 'Agent key'});
    keyBox.replaceChildren(
      h('label', {}, 'Agent key · shown once', h('div', {class: 'secret'}, input,
        h('button', {class: 'btn', type: 'button', onclick: () => copy(data.token, 'Key copied')}, icon('copy'), 'Copy'))),
      h('label', {}, 'Portal address', h('div', {class: 'secret'}, h('input', {readonly: true, value: data.origin}),
        h('button', {class: 'btn', type: 'button', onclick: () => copy(data.origin, 'Address copied')}, icon('copy'), 'Copy'))),
      data.fingerprint ? h('label', {}, 'Certificate fingerprint', h('div', {class: 'secret'}, h('input', {readonly: true, value: data.fingerprint}),
        h('button', {class: 'btn', type: 'button', onclick: () => copy(data.fingerprint, 'Fingerprint copied')}, icon('copy'), 'Copy'))) : null,
      h('label', {}, 'Command for the other computer', h('div', {class: 'secret'}, h('input', {readonly: true, value: 'python connector.py --portal ' + data.origin + (data.fingerprint ? ' --fingerprint ' + data.fingerprint : '')}),
        h('button', {class: 'btn', type: 'button', onclick: () => copy('python connector.py --portal ' + data.origin + (data.fingerprint ? ' --fingerprint ' + data.fingerprint : ''), 'Command copied')}, icon('copy'), 'Copy'))));
    keyBox.hidden = false;
    loadDevices();
  } catch (error) { toast(error.message, true); }
}

async function newQr() {
  clearInterval(qrTimer);
  try {
    const data = await api('/api/connect/tablet', {});
    const countdown = h('p');
    qrBox.replaceChildren(h('div', {class: 'qr'}, h('img', {src: data.qr, alt: 'Pairing QR code'}), countdown),
      h('div', {class: 'card-actions', style: 'margin-top:10px'},
        h('button', {class: 'btn sm', type: 'button', onclick: () => copy(data.link, 'Pairing link copied')}, icon('copy'), 'Copy link'),
        h('button', {class: 'btn ghost sm', type: 'button', onclick: newQr}, 'New code')));
    qrBox.hidden = false;
    const tick = () => {
      const left = data.expires * 1000 - Date.now() - state.skew;
      if (left <= 0) { clearInterval(qrTimer); qrBox.hidden = true; return; }
      countdown.textContent = `Pair with ${data.profile} · expires in ${Math.floor(left / 60000)}:${String(Math.floor(left / 1000) % 60).padStart(2, '0')}`;
    };
    tick();
    qrTimer = setInterval(() => { tick(); if (Math.floor(Date.now() / 1000) % 4 === 0) loadDevices(); }, 1000);
  } catch (error) { toast(error.message, true); }
}

async function loadDevices() {
  try {
    const {items, now} = await api('/api/devices');
    if (!items.length) return rows.replaceChildren(empty('devices', 'No devices yet', 'Connect a computer or pair a phone to get started.'));
    rows.replaceChildren(...items.map(item => {
      const online = now - item.seen < 30;
      return h('div', {class: 'list-item'},
        h('span', {class: 'list-icon'}, icon(item.kind === 'agent' ? 'devices' : 'qr')),
        h('span', {class: 'grow'}, h('span', {class: 'title', text: item.name || (item.kind === 'agent' ? 'Desktop agent' : 'Mobile device')}),
          h('span', {class: 'sub', text: (item.kind === 'agent' ? 'Desktop agent' : 'Phone or tablet') + ' · ' + (online ? 'active now' : 'last seen ' + ago(item.seen * 1000))})),
        h('span', {class: 'pill ' + (online ? 'good' : ''), text: online ? 'Online' : 'Offline'}),
        h('button', {class: 'btn ghost sm danger', type: 'button', onclick: async () => {
          if (!await confirmAction('Disconnect device?', `${item.name} will need a new key or QR code to reconnect.`, 'Disconnect', true)) return;
          try {
            await api('/api/devices/revoke', {id: item.id});
            if (item.kind === 'agent') state.user.localLinked = false;
            toast('Device disconnected.');
            render();
          } catch (error) { toast(error.message, true); }
        }}, 'Disconnect'));
    }));
  } catch (error) { rows.replaceChildren(empty('warning', 'Could not load devices', error.message)); }
}
export function show() { render(); }
export function hide() { clearInterval(qrTimer); }
export function update() {}
