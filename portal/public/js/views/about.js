import {h, icon, state} from '../core.js';

export const AUTHOR = {name: 'Diogo Moreira', url: 'https://github.com/diogosmoreira84'};
export const meta = {title: 'About', description: 'The story, the license and the people behind Assistente IA.'};
let root;

const external = (href, text) => h('a', {href, target: '_blank', rel: 'noopener noreferrer'}, text);

export function mount(section) { root = section; }
export function show() {
  const year = new Date().getFullYear();
  root.replaceChildren(h('div', {class: 'about'},
    h('article', {class: 'card about-hero'},
      h('img', {src: '/assets/logo.svg', alt: '', width: 72, height: 72}),
      h('div', {},
        h('h2', {class: 'about-title'}, 'Assistente ', h('b', {text: 'IA'})),
        h('p', {class: 'muted', text: 'A self-hosted companion for AI coding agents. Watch Claude Code and Codex work, keep an eye on usage limits, and answer their requests from any screen.'}),
        h('div', {class: 'about-meta'},
          h('span', {class: 'pill accent', text: 'Version ' + (state.user?.version || '1.x')}),
          h('span', {class: 'pill', text: 'MIT License'}),
          h('span', {class: 'pill', text: 'Self-hosted'})))),
    h('article', {class: 'card about-author'},
      h('span', {class: 'avatar about-avatar', text: 'DM'}),
      h('div', {},
        h('span', {class: 'muted small', text: 'Created by'}),
        h('h2', {text: AUTHOR.name}),
        h('p', {class: 'muted', text: 'Designed and built Assistente IA to keep coding agents moving without being tied to the desk.'}),
        h('div', {class: 'card-actions'}, h('a', {class: 'btn', href: AUTHOR.url, target: '_blank', rel: 'noopener noreferrer'}, icon('github'), 'GitHub', icon('external'))))),
    h('div', {class: 'grid-2'},
      h('article', {class: 'card'}, h('h2', {text: 'Privacy'}), h('ul', {class: 'steps about-list'},
        h('li', {text: 'Runs on your own computer. Nothing is sent to third-party servers.'}),
        h('li', {text: 'Passwords use scrypt; device and session keys are stored only as hashes.'}),
        h('li', {text: 'Activity is kept for 30 days and can be cleared at any time.'}),
        h('li', {text: 'Deleting your account erases every record.'}))),
      h('article', {class: 'card'}, h('h2', {text: 'Open source'}), h('ul', {class: 'steps about-list'},
        h('li', {}, external('https://github.com/ersinkoc/phonebox', 'PhoneBox'), ' by ersinkoc, MIT License: the desktop agent.'),
        h('li', {}, external('https://github.com/lobehub/lobe-icons', 'Lobe Icons'), ', MIT License: Claude and Codex artwork.'),
        h('li', {}, external('https://github.com/zxing/zxing', 'ZXing'), ', Apache 2.0: QR scanning in the Android app.'),
        h('li', {}, external('https://github.com/lincolnloop/python-qrcode', 'python-qrcode'), ', BSD: QR code generation.')))),
    h('article', {class: 'card'}, h('h2', {text: 'License'}),
      h('p', {class: 'muted license', text: `MIT License · Copyright © ${year} ${AUTHOR.name}\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software, to deal in the software without restriction, provided that the above copyright notice and this permission notice are included in all copies or substantial portions of the software. The software is provided "as is", without warranty of any kind.`})),
    h('p', {class: 'about-foot muted small', text: `Assistente IA · Created by ${AUTHOR.name} · © ${year}`})));
}
export function update() {}
