import {h, icon, api, state, empty, card, toast, openDialog, ago, fmtDate} from '../core.js';

export const meta = {title: 'GitHub', description: 'Pull requests, reviews and repositories from the GitHub account on your PC.'};
let root, prs, repos, pager, account, page = 1, login = '', loaded = false, filterText = '', repoItems = [];

export function mount(section) {
  root = section;
  prs = h('div', {class: 'grid-2'});
  repos = h('div');
  pager = h('div', {class: 'card-actions', hidden: true, style: 'justify-content:center;margin-top:12px'});
  account = h('div');
  const search = h('input', {type: 'search', placeholder: 'Filter this page', 'aria-label': 'Filter repositories',
    oninput: event => { filterText = event.target.value.toLowerCase(); renderRepos(); }});
  root.replaceChildren(account, prs,
    card('Repositories', 'Uses the GitHub CLI session on your linked Windows PC',
      [h('div', {class: 'search', style: 'position:relative;width:200px'}, search),
        h('button', {class: 'btn primary', type: 'button', onclick: createRepo}, icon('plus'), 'New repository')], repos, pager));
}

function ciPill(ci) {
  const value = String(ci || '').toUpperCase();
  if (!value) return null;
  if (value === 'SUCCESS') return h('span', {class: 'pill good'}, icon('check'), 'Checks passed');
  if (['FAILURE', 'ERROR'].includes(value)) return h('span', {class: 'pill bad'}, icon('x'), 'Checks failed');
  return h('span', {class: 'pill warn'}, icon('clock'), 'Checks running');
}
function reviewPill(review) {
  const value = String(review || '').toUpperCase();
  return value === 'APPROVED' ? h('span', {class: 'pill good', text: 'Approved'})
    : value === 'CHANGES_REQUESTED' ? h('span', {class: 'pill bad', text: 'Changes requested'})
      : value === 'REVIEW_REQUIRED' ? h('span', {class: 'pill', text: 'Review required'}) : null;
}
function prItem(pr) {
  const url = /^[\w.-]+\/[\w.-]+$/.test(pr.repo || '') && Number.isInteger(pr.number) ? `https://github.com/${pr.repo}/pull/${pr.number}` : null;
  return h('div', {class: 'list-item'},
    h('span', {class: 'list-icon'}, icon('pr')),
    h('span', {class: 'grow'},
      url ? h('a', {class: 'title', href: url, target: '_blank', rel: 'noopener noreferrer', text: pr.title || 'Pull request'}) : h('span', {class: 'title', text: pr.title}),
      h('span', {class: 'sub', text: `${pr.repo} #${pr.number}` + (pr.author ? ' · ' + pr.author : '') + (pr.updated ? ' · ' + ago(pr.updated) : '') + (pr.draft ? ' · draft' : '')})),
    h('span', {class: 'card-actions'}, reviewPill(pr.review), ciPill(pr.ci)));
}
let signature = '';
function renderAgentData(data, force = false) {
  const gh = data?.online ? data.github || {} : {};
  const next = JSON.stringify([gh, login, Boolean(data?.online)]);
  if (next === signature && !force) return;
  signature = next;
  account.replaceChildren(h('div', {class: 'stats'},
    h('div', {class: 'stat'}, h('span', {class: 'stat-label'}, icon('github'), 'Account'), h('span', {class: 'stat-value', text: gh.user || login || '—'}),
      h('span', {class: 'stat-sub', text: gh.error || (gh.updatedAt ? 'Updated ' + ago(gh.updatedAt) : 'From the desktop agent')})),
    h('div', {class: 'stat'}, h('span', {class: 'stat-label'}, icon('bell'), 'Notifications'), h('span', {class: 'stat-value', text: String(gh.notifications ?? '—')}),
      h('a', {class: 'stat-sub', href: 'https://github.com/notifications', target: '_blank', rel: 'noopener noreferrer', text: 'Open inbox'})),
    h('div', {class: 'stat'}, h('span', {class: 'stat-label'}, icon('pr'), 'Review requests'), h('span', {class: 'stat-value', text: String(gh.reviewRequests?.length ?? '—')}),
      h('span', {class: 'stat-sub', text: 'Waiting for your review'})),
    h('div', {class: 'stat'}, h('span', {class: 'stat-label'}, icon('pr'), 'Your open PRs'), h('span', {class: 'stat-value', text: String(gh.myPrs?.length ?? '—')}),
      h('span', {class: 'stat-sub', text: `${(gh.myPrs || []).filter(p => /FAIL|ERROR/i.test(p.ci || '')).length} with failing checks`}))));
  prs.replaceChildren(
    card('Review requests', null, null, gh.reviewRequests?.length ? h('div', {class: 'list'}, gh.reviewRequests.map(prItem))
      : empty('check', 'Nothing to review', data?.online ? 'You are all caught up.' : 'Connect a desktop agent to see pull requests.')),
    card('Your pull requests', null, null, gh.myPrs?.length ? h('div', {class: 'list'}, gh.myPrs.map(prItem))
      : empty('pr', 'No open pull requests')));
}

function renderRepos() {
  const items = repoItems.filter(r => !filterText || `${r.name} ${r.description || ''}`.toLowerCase().includes(filterText));
  if (!items.length) return repos.replaceChildren(empty('repo', repoItems.length ? 'No matches on this page' : 'No repositories found'));
  repos.replaceChildren(h('div', {class: 'list'}, items.map(repo => h('div', {class: 'list-item'},
    h('span', {class: 'list-icon'}, icon('repo')),
    h('span', {class: 'grow'},
      typeof repo.url === 'string' && repo.url.startsWith('https://github.com/')
        ? h('a', {class: 'title', href: repo.url, target: '_blank', rel: 'noopener noreferrer', text: repo.name}) : h('span', {class: 'title', text: repo.name}),
      h('span', {class: 'sub', text: [repo.description, repo.language, repo.updated && 'updated ' + fmtDate(repo.updated)].filter(Boolean).join(' · ')})),
    h('span', {class: 'pill' + (repo.private ? '' : ' accent'), text: repo.private ? 'Private' : 'Public'})))));
}
async function loadRepos(target = 1) {
  if (!state.user?.localAgent) {
    repos.replaceChildren(empty('github', 'Available on the host PC', 'Open the portal on the Windows PC that runs the agent and link it under Devices to manage repositories.'));
    return;
  }
  repos.replaceChildren(h('p', {class: 'muted small', text: 'Loading repositories…'}));
  try {
    if (!login) login = (await api('/api/github/account')).login || '';
    const data = await api('/api/github/repos?page=' + target);
    page = data.page;
    repoItems = data.items;
    renderRepos();
    pager.hidden = page === 1 && !data.more;
    pager.replaceChildren(
      h('button', {class: 'btn sm', type: 'button', disabled: page === 1, onclick: () => loadRepos(page - 1)}, 'Previous'),
      h('span', {class: 'muted small', text: 'Page ' + page}),
      h('button', {class: 'btn sm', type: 'button', disabled: !data.more, onclick: () => loadRepos(page + 1)}, 'Next'));
    renderAgentData(state.data);
  } catch (error) {
    pager.hidden = true;
    repos.replaceChildren(empty('github', 'Repositories unavailable', error.message,
      error.status === 403 ? h('a', {class: 'btn', href: '#/devices'}, 'Link this PC') : null));
  }
}
async function createRepo() {
  const created = await openDialog('New repository', body => body.append(
    h('label', {}, 'Name', h('input', {name: 'name', required: true, maxlength: 100, pattern: '[A-Za-z0-9][A-Za-z0-9_.\\-]{0,99}', placeholder: 'my-project'})),
    h('label', {}, 'Description', h('input', {name: 'description', maxlength: 350, placeholder: 'Optional'})),
    h('label', {class: 'check'}, h('input', {type: 'checkbox', name: 'private', checked: true}), 'Private repository')),
  {submit: 'Create repository', onSubmit: values => api('/api/github/repos/create',
    {name: values.name.trim(), description: (values.description || '').trim(), private: values.private === 'on'})});
  if (created) { toast('Created ' + created.repository.name + '.'); loadRepos(1); }
}
export function show() { renderAgentData(state.data, true); if (!loaded) { loaded = true; loadRepos(1); } }
export function update(data) { if (root && !root.hidden) renderAgentData(data); }
export function reset() { loaded = false; login = ''; repoItems = []; }
