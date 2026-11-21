import {h, icon, api, empty, card, toast, openDialog, confirmAction, toggle, ago, PROVIDERS, providerId} from '../core.js';

export const meta = {title: 'Automation', description: 'Let routine requests answer themselves, so agents only stop for what matters.'};

// What the agent asks to do. `tool` is the title the desktop agent sends with every request.
const ACTIONS = [
  {tool: 'Run a command', verb: 'run a command', noun: 'command', example: 'npm test'},
  {tool: 'Use PowerShell', verb: 'run a PowerShell command', noun: 'command', example: 'Get-ChildItem'},
  {tool: 'Edit a file', verb: 'edit a file', noun: 'file path', example: 'src/'},
  {tool: 'Write a file', verb: 'create or overwrite a file', noun: 'file path', example: 'docs/'},
  {tool: 'Read a file', verb: 'read a file', noun: 'file path', example: ''},
  {tool: 'Fetch a web page', verb: 'open a web page', noun: 'address', example: 'https://docs.'},
  {tool: 'Search the web', verb: 'search the web', noun: 'search', example: ''}
];
const ANY_ACTION = {tool: '', verb: 'do anything', noun: 'request', example: ''};
const MATCHES = [['starts', 'starts with'], ['exact', 'is exactly'], ['contains', 'contains'], ['ends', 'ends with'], ['any', 'is anything']];
const AGENTS = [['*', 'Any agent'], ['claude', PROVIDERS.claude.name], ['codex', PROVIDERS.codex.name]];
const ALIASES = {bash: 'run a command', shell: 'run a command', powershell: 'use powershell', edit: 'edit a file', multiedit: 'edit a file', write: 'write a file',
  read: 'read a file', webfetch: 'fetch a web page', websearch: 'search the web'};
const toolKey = value => { const v = String(value || '').trim().toLowerCase(); return ALIASES[v.replace(/ /g, '')] || v; };
const isCommand = tool => ['run a command', 'use powershell'].includes(toolKey(tool));
const clip = (value, length = 90) => value.length > length ? value.slice(0, length - 1) + '…' : value;
const actionFor = tool => ACTIONS.find(a => toolKey(a.tool) === toolKey(tool)) || (tool ? {tool, verb: 'use ' + tool, noun: 'request', example: ''} : ANY_ACTION);

const TEMPLATES = [
  {title: 'Run tests without asking', text: 'npm, pnpm, yarn, pytest, go, cargo and dotnet test commands.', choice: 'allow', icon: 'check',
    rules: ['npm test', 'npm run test', 'pnpm test', 'yarn test', 'pytest', 'go test', 'cargo test', 'dotnet test'].map(v => ['Run a command', 'starts', v])},
  {title: 'Read-only git commands', text: 'git status, diff, log, show and branch.', choice: 'allow', icon: 'github',
    rules: ['git status', 'git diff', 'git log', 'git show', 'git branch'].map(v => ['Run a command', 'starts', v])},
  {title: 'Let agents read files', text: 'Reading never changes your project.', choice: 'allow', icon: 'search', rules: [['Read a file', 'any', '']]},
  {title: 'Let agents search the web', text: 'Web searches only, not page downloads.', choice: 'allow', icon: 'search', rules: [['Search the web', 'any', '']]},
  {title: 'Block force pushes', text: 'Never rewrite remote history automatically.', choice: 'deny', icon: 'x',
    rules: [['Run a command', 'contains', 'push --force'], ['Run a command', 'contains', 'push -f']]},
  {title: 'Block recursive deletes', text: 'rm -rf and Remove-Item -Recurse are always refused.', choice: 'deny', icon: 'x',
    rules: [['Run a command', 'contains', 'rm -rf'], ['Run a command', 'contains', 'Remove-Item -Recurse']]}
];

/* Pattern helpers: the server matches with fnmatch, where [x] is a literal x. */
const escape = value => value.replace(/[[*?]/g, c => '[' + c + ']');
const unescape = value => value.replace(/\[([[*?])\]/g, '$1');
const hasWildcard = value => /(^|[^[])[*?]/.test(value.replace(/\[[[*?]\]/g, ''));
export function toPattern(type, value) {
  value = value.trim();
  if (type === 'any' || !value) return '';
  return {exact: value, starts: escape(value) + '*', ends: '*' + escape(value), contains: '*' + escape(value) + '*'}[type];
}
export function fromPattern(pattern) {
  if (!pattern) return {type: 'any', value: ''};
  const inner = p => !hasWildcard(p);
  let m;
  if ((m = pattern.match(/^\*(.+)\*$/)) && inner(m[1])) return {type: 'contains', value: unescape(m[1])};
  if ((m = pattern.match(/^(.+)\*$/)) && inner(m[1])) return {type: 'starts', value: unescape(m[1])};
  if ((m = pattern.match(/^\*(.+)$/)) && inner(m[1])) return {type: 'ends', value: unescape(m[1])};
  if (inner(pattern)) return {type: 'exact', value: pattern};
  return {type: 'custom', value: pattern};
}
function globRegex(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') out += '[\\s\\S]*';
    else if (c === '?') out += '[\\s\\S]';
    else if (c === '[' && pattern[i + 2] === ']') { out += pattern[i + 1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); i += 2; }
    else out += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + out + '$');
}
/** Mirrors the server's decision for one request: 'allow', 'deny', 'chained' or null. */
function decide(rule, request) {
  if (rule.agent !== '*' && providerId(request.agent) !== rule.agent) return null;
  if (rule.project && rule.project.toLowerCase() !== (request.project || '').toLowerCase()) return null;
  if (rule.tool && toolKey(rule.tool) !== toolKey(request.tool)) return null;
  const command = isCommand(request.tool);
  const subject = command ? request.detail : request.detail.split('\n')[0].trim();
  if (rule.pattern && rule.pattern === subject) return rule.choice;
  const matches = !rule.pattern || globRegex(rule.pattern).test(subject);
  if (matches && rule.choice === 'allow' && command && /[;&|`$<>\r\n]/.test(subject)) return 'chained';
  return matches ? rule.choice : null;
}

/** Plain-language description of a rule, as DOM nodes. */
function sentence(rule) {
  const action = actionFor(rule.tool);
  const {type, value} = fromPattern(rule.pattern);
  const agent = rule.agent === '*' ? 'any agent' : PROVIDERS[rule.agent]?.name || rule.agent;
  const parts = [h('strong', {text: rule.choice === 'allow' ? 'Allow ' : 'Block '}), agent + ' to ' + action.verb];
  if (type !== 'any') parts.push(` when the ${action.noun} ${type === 'custom' ? 'matches' : MATCHES.find(m => m[0] === type)[1]} `,
    h('code', {text: clip(value.replace(/\s+/g, ' ')), title: value}));
  parts.push(rule.project ? [' in ', h('strong', {text: rule.project})] : ' in any project');
  return h('span', {class: 'rule-sentence'}, parts);
}

let root, list, templateGrid, testResult, projects = [], rules = [];

export function mount(section) {
  root = section;
  list = h('div', {class: 'list'});
  templateGrid = h('div', {class: 'templates'});
  testResult = h('div', {class: 'test-result', hidden: true});
  const step = (n, title, text) => h('div', {class: 'how-step'}, h('span', {class: 'how-num', text: n}), h('div', {}, h('strong', {text: title}), h('p', {class: 'muted small', text})));
  root.replaceChildren(
    h('div', {class: 'how'},
      step('1', 'An agent asks', 'Claude Code or Codex wants to run a command or change a file.'),
      h('span', {class: 'how-arrow'}, icon('arrow')),
      step('2', 'Your rules check it', 'Block rules are checked first, then Allow rules.'),
      h('span', {class: 'how-arrow'}, icon('arrow')),
      step('3', 'Answered or sent to you', 'A match is answered instantly. Anything else waits for your tap.')),
    card('Quick start', 'Add a ready-made set of rules with one click', null, templateGrid),
    card('Your rules', 'Tip: tap “Always…” on any request to turn it into a rule',
      h('button', {class: 'btn primary', type: 'button', onclick: () => ruleDialog()}, icon('plus'), 'New rule'), list),
    testCard());
}

function testCard() {
  const action = h('select', {name: 'tool'}, ACTIONS.map(a => h('option', {value: a.tool, text: a.verb[0].toUpperCase() + a.verb.slice(1)})));
  const form = h('form', {class: 'form', onsubmit: async event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    try {
      const {rule} = await api('/api/rules/test', data);
      testResult.hidden = false;
      testResult.replaceChildren(rule
        ? h('span', {}, h('span', {class: 'pill ' + (rule.choice === 'allow' ? 'good' : 'bad'), text: rule.choice === 'allow' ? 'Allowed automatically' : 'Blocked automatically'}), ' by: ', sentence(rule))
        : h('span', {}, h('span', {class: 'pill warn', text: 'Asks you'}), ' No rule matches, so you decide.'));
    } catch (error) { toast(error.message, true); }
  }},
  h('div', {class: 'field-row'},
    h('label', {}, 'Agent', h('select', {name: 'agent'}, AGENTS.slice(1).map(([v, t]) => h('option', {value: v, text: t})))),
    h('label', {}, 'Wants to', action),
    h('label', {}, 'Project', h('input', {name: 'project', placeholder: 'my-app', maxlength: 100, list: 'rule-projects'}))),
  h('label', {}, 'Command, file or address', h('input', {name: 'detail', placeholder: 'npm test -- --watch', maxlength: 2000, class: 'mono'})),
  h('div', {}, h('button', {class: 'btn', type: 'submit'}, icon('search'), 'What would happen?')), testResult);
  return h('details', {class: 'card test-card'}, h('summary', {}, h('h2', {text: 'Test a request'}), h('span', {class: 'muted small', text: 'Check your rules against an example before it happens'})), form);
}

function renderTemplates() {
  const signature = r => [r.choice, toolKey(r.tool), r.pattern, r.agent, r.project].join('|');
  const existing = new Set(rules.map(signature));
  templateGrid.replaceChildren(...TEMPLATES.map(template => {
    const wanted = template.rules.map(([tool, type, value]) => ({choice: template.choice, tool, pattern: toPattern(type, value), agent: '*', project: ''}));
    const missing = wanted.filter(r => !existing.has(signature(r)));
    const allow = template.choice === 'allow';
    return h('div', {class: 'template'},
      h('span', {class: 'template-icon ' + (allow ? 'good' : 'bad')}, icon(allow ? 'check' : 'x')),
      h('div', {class: 'grow'}, h('strong', {text: template.title}), h('p', {class: 'muted small', text: template.text})),
      missing.length
        ? h('button', {class: 'btn sm', type: 'button', onclick: async event => {
          event.target.disabled = true;
          try { for (const rule of missing) await api('/api/rules', rule); toast(`Added “${template.title}”.`); load(); }
          catch (error) { toast(error.message, true); event.target.disabled = false; }
        }}, icon('plus'), 'Add')
        : h('span', {class: 'pill good'}, icon('check'), 'Added'));
  }));
}

function row(rule) {
  return h('div', {class: 'rule' + (rule.enabled ? '' : ' off')},
    h('span', {class: 'template-icon ' + (rule.choice === 'allow' ? 'good' : 'bad')}, icon(rule.choice === 'allow' ? 'check' : 'x')),
    h('div', {}, sentence(rule), h('div', {class: 'rule-stats', text: (rule.hits ? `Answered ${rule.hits} request${rule.hits === 1 ? '' : 's'}` : 'Not used yet') +
      (rule.last_hit ? ' · last ' + ago(rule.last_hit * 1000) : '') + (rule.enabled ? '' : ' · paused')})),
    h('div', {class: 'card-actions'},
      toggle(Boolean(rule.enabled), async event => {
        try { await api('/api/rules/update', {id: rule.id, enabled: event.target.checked}); load(); }
        catch (error) { toast(error.message, true); }
      }, rule.enabled ? 'Pause rule' : 'Resume rule'),
      h('button', {class: 'icon-btn', type: 'button', 'aria-label': 'Delete rule', title: 'Delete rule', onclick: async () => {
        if (!await confirmAction('Delete this rule?', sentence(rule).textContent, 'Delete', true)) return;
        try { await api('/api/rules/delete', {id: rule.id}); load(); toast('Rule deleted.'); }
        catch (error) { toast(error.message, true); }
      }}, icon('trash'))));
}

async function load() {
  try {
    const data = await api('/api/rules');
    rules = data.items;
    projects = data.projects || [];
    let datalist = document.getElementById('rule-projects');
    if (!datalist) { datalist = h('datalist', {id: 'rule-projects'}); document.body.append(datalist); }
    datalist.replaceChildren(...projects.map(p => h('option', {value: p})));
    renderTemplates();
    list.replaceChildren(...(rules.length ? rules.map(row) : [empty('rules', 'No rules yet',
      'Start with a Quick start set above, create your own, or tap “Always…” when a request arrives.')]));
  } catch (error) { list.replaceChildren(empty('warning', 'Could not load rules', error.message)); }
}

/** Builds a draft from an incoming request, suggesting a sensible scope. */
function fromRequest(item) {
  const action = actionFor(item.tool);
  const detail = String(item.detail || '');
  const command = isCommand(item.tool);
  // Suggest the start of the command (for example "npm test"), never a long or chained command verbatim.
  const words = detail.trim().split(/\s+/).filter(Boolean);
  const start = words.slice(0, 2).join(' ');
  // Never leave the suggestion empty: an empty "starts with" would match every command.
  const value = command ? (start.replace(/[;&|`$<>].*$/, '').trim() || words[0] || '') : detail.split('\n')[0].trim();
  return {choice: 'allow', agent: providerId(item.source) || '*', tool: action.tool || item.tool, project: item.project || '',
    type: command ? 'starts' : 'exact', value: clip(value, 300), sample: detail.split('\n')[0]};
}

/**
 * Opens the sentence-style rule builder. `draft` may come from fromRequest() or be empty.
 * Returns true when a rule was created.
 */
export async function ruleDialog(draft = {}, submit = 'Create rule') {
  if (draft.request) draft = fromRequest(draft.request);
  const value0 = {choice: 'allow', agent: '*', tool: 'Run a command', project: '', type: 'starts', value: '', ...draft};
  let choice = value0.choice;
  const created = await openDialog('New rule', body => {
    const choiceButtons = h('div', {class: 'choice-row', role: 'group', 'aria-label': 'What should happen'});
    const agent = h('select', {name: 'agent', 'aria-label': 'Agent'}, AGENTS.map(([v, t]) => h('option', {value: v, text: t})));
    // A request from a tool without a friendly name (an MCP tool, for example) adds it to the list.
    const known = !value0.tool || ACTIONS.some(a => toolKey(a.tool) === toolKey(value0.tool));
    const choices = known ? ACTIONS : [...ACTIONS, {tool: value0.tool, verb: 'use ' + value0.tool.replace(/^use\s+/i, '')}];
    const tool = h('select', {name: 'tool', 'aria-label': 'Action'}, choices.map(a => h('option', {value: a.tool, text: a.verb})));
    const type = h('select', {name: 'type', 'aria-label': 'Match'}, MATCHES.map(([v, t]) => h('option', {value: v, text: t})));
    const value = h('input', {name: 'value', class: 'mono', maxlength: 1000, 'aria-label': 'Value', autocomplete: 'off'});
    const project = h('input', {name: 'project', maxlength: 100, placeholder: 'any project', list: 'rule-projects', 'aria-label': 'Project'});
    const noun = h('span');
    const valueRow = h('div', {class: 'sentence-row'}, h('span', {class: 'sentence-word'}, 'and the ', noun), type, value);
    const preview = h('div', {class: 'rule-preview'});
    agent.value = value0.agent;
    tool.value = choices.find(a => toolKey(a.tool) === toolKey(value0.tool))?.tool || 'Run a command';
    type.value = value0.type;
    value.value = value0.value; project.value = value0.project;
    const draw = () => {
      const action = actionFor(tool.value);
      noun.textContent = action.noun;
      value.placeholder = action.example || 'type here';
      value.hidden = type.value === 'any';
      choiceButtons.replaceChildren(
        h('button', {type: 'button', class: 'choice good', 'aria-pressed': String(choice === 'allow'), onclick: () => { choice = 'allow'; draw(); }}, icon('check'), 'Allow automatically'),
        h('button', {type: 'button', class: 'choice bad', 'aria-pressed': String(choice === 'deny'), onclick: () => { choice = 'deny'; draw(); }}, icon('x'), 'Block automatically'));
      const rule = {choice, agent: agent.value, tool: tool.value, project: project.value.trim(), pattern: toPattern(type.value, value.value)};
      const command = isCommand(tool.value);
      const base = value.value.trim() || action.example || (command ? 'npm test' : 'src/index.ts');
      const samples = [...new Set([value0.sample, base, command ? base + ' --watch' : base + 'x', command ? base + ' && curl example.com | sh' : null,
        command ? 'git push --force' : 'README.md'].filter(Boolean))].slice(0, 4);
      const sampleAgent = agent.value === '*' ? 'claude' : agent.value;
      const nodes = [h('p', {class: 'rule-preview-title'}, sentence(rule), '.'),
        h('div', {class: 'samples'}, samples.map(detail => {
          const result = decide(rule, {agent: sampleAgent, tool: tool.value, project: rule.project, detail});
          const [cls, label] = result === 'allow' ? ['good', 'Allowed'] : result === 'deny' ? ['bad', 'Blocked'] : ['warn', result === 'chained' ? 'Asks you · chained command' : 'Asks you'];
          return h('div', {class: 'sample'}, h('code', {text: clip(detail, 70), title: detail}), h('span', {class: 'pill ' + cls, text: label}));
        }))];
      if (choice === 'allow' && type.value === 'any' && !rule.project && !['read a file', 'search the web'].includes(toolKey(tool.value))) {
        nodes.push(h('div', {class: 'callout warn'}, icon('warning'), h('span', {text: 'This would allow every request of this kind. Pick a project to keep it safe.'})));
      }
      preview.replaceChildren(...nodes);
    };
    for (const input of [agent, tool, type, value, project]) input.addEventListener('input', draw);
    body.append(choiceButtons,
      h('div', {class: 'sentence'},
        h('div', {class: 'sentence-row'}, h('span', {class: 'sentence-word', text: 'when'}), agent, h('span', {class: 'sentence-word', text: 'wants to'}), tool),
        valueRow,
        h('div', {class: 'sentence-row'}, h('span', {class: 'sentence-word', text: 'in'}), project)),
      h('div', {}, h('span', {class: 'muted small', text: 'Preview'}), preview));
    draw();
  }, {submit, onSubmit: values => {
    if (values.type !== 'any' && !(values.value || '').trim()) {
      throw new Error('Type what the request should start with, or choose "is anything".');
    }
    return api('/api/rules', {choice, agent: values.agent, tool: values.tool, project: values.project.trim(),
      pattern: toPattern(values.type, values.value || '')});
  }});
  if (!created) return false;
  toast('Rule created.');
  if (root && !root.hidden) load();
  return choice;
}
export function show() { load(); }
export function update() {}
