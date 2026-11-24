import './connection.css';
import type { ConnectionFormData, FormToExtension, FormToWebview } from '../../src/shared/protocol';
import { h, icon } from '../common/dom';
import { vscode } from '../common/dom';

const api = vscode();
const send = (m: FormToExtension) => api.postMessage(m);
const app = document.getElementById('app')!;

const COLORS: { id: string; label: string; css: string }[] = [
  { id: '', label: 'None', css: 'transparent' },
  { id: 'charts.red', label: 'Red — production', css: 'var(--vscode-charts-red)' },
  { id: 'charts.orange', label: 'Orange', css: 'var(--vscode-charts-orange)' },
  { id: 'charts.yellow', label: 'Yellow — staging', css: 'var(--vscode-charts-yellow)' },
  { id: 'charts.green', label: 'Green — local', css: 'var(--vscode-charts-green)' },
  { id: 'charts.blue', label: 'Blue', css: 'var(--vscode-charts-blue)' },
  { id: 'charts.purple', label: 'Purple', css: 'var(--vscode-charts-purple)' },
];

let data: ConnectionFormData;
let busy = false;

function field(label: string, control: HTMLElement, hint?: string, cls = ''): HTMLElement {
  return h('label', { class: `field ${cls}` }, h('span.label', null, label), control, hint ? h('span.hint', null, hint) : null);
}

function text(get: () => string, set: (v: string) => void, attrs: Record<string, unknown> = {}): HTMLInputElement {
  const el = h('input', { type: 'text', value: get(), spellcheck: false, ...attrs });
  el.addEventListener('input', () => set(el.value));
  return el;
}

function num(get: () => number, set: (v: number) => void, attrs: Record<string, unknown> = {}): HTMLInputElement {
  const el = h('input', { type: 'number', value: String(get()), ...attrs });
  el.addEventListener('input', () => set(Number(el.value)));
  return el;
}

function password(get: () => string, set: (v: string) => void, placeholder = ''): HTMLElement {
  const el = h('input', { type: 'password', value: get(), placeholder, autocomplete: 'off' });
  el.addEventListener('input', () => set(el.value));
  const eye = h('button.icon-btn.eye', {
    type: 'button',
    title: 'Show / hide',
    onclick: () => {
      el.type = el.type === 'password' ? 'text' : 'password';
      eye.replaceChildren(icon(el.type === 'password' ? 'eye' : 'eye-closed'));
    },
  }, icon('eye'));
  return h('div.input-with-btn', null, el, eye);
}

function fileInput(fieldId: string, get: () => string, set: (v: string) => void, placeholder: string): HTMLElement {
  const el = text(get, set, { placeholder, dataset: { file: fieldId } });
  return h('div.input-with-btn', null, el, h('button.btn.secondary.browse', { type: 'button', onclick: () => send({ type: 'pickFile', field: fieldId }) }, 'Browse…'));
}

function checkbox(label: string, get: () => boolean, set: (v: boolean) => void, hint?: string): HTMLElement {
  const el = h('input', { type: 'checkbox', checked: get() });
  el.addEventListener('change', () => {
    set(el.checked);
    render();
  });
  return h('label.check', null, el, h('span', null, label, hint ? h('span.hint.block', null, hint) : null));
}

function section(title: string, ic: string, body: HTMLElement[], toggle?: { get: () => boolean; set: (v: boolean) => void }, subtitle?: string): HTMLElement {
  const on = toggle ? toggle.get() : true;
  let head: HTMLElement;
  if (toggle) {
    const sw = h('input', { type: 'checkbox', class: 'switch', checked: on });
    sw.addEventListener('change', () => {
      toggle.set(sw.checked);
      render();
    });
    head = h('label.section-head.toggle', null, icon(ic), h('span.section-title', null, title), subtitle ? h('span.muted.section-sub', null, subtitle) : null, h('span.spacer'), sw);
  } else {
    head = h('div.section-head', null, icon(ic), h('span.section-title', null, title), subtitle ? h('span.muted.section-sub', null, subtitle) : null);
  }
  return h('section', { class: `card ${on ? '' : 'collapsed'}` }, head, on ? h('div.section-body', null, body) : null);
}

/** mysql://user:pass@host:port/db?ssl=true */
function applyUrl(url: string): boolean {
  try {
    const u = new URL(url.trim());
    if (!/^(mysql|mariadb|mysqlx?):$/.test(u.protocol)) return false;
    data.host = decodeURIComponent(u.hostname) || data.host;
    data.port = Number(u.port) || 3306;
    if (u.username) data.user = decodeURIComponent(u.username);
    if (u.password) data.password = decodeURIComponent(u.password);
    const db = u.pathname.replace(/^\//, '');
    if (db) data.database = decodeURIComponent(db);
    const ssl = u.searchParams.get('ssl') ?? u.searchParams.get('sslmode') ?? u.searchParams.get('ssl-mode');
    if (ssl && !/^(false|0|disabled?)$/i.test(ssl)) data.ssl.enabled = true;
    if (!data.name) data.name = `${data.user}@${data.host}`;
    return true;
  } catch {
    return false;
  }
}

const testResult = h('div.test-result');
const saveError = h('div.save-error');

function render(): void {
  const d = data;
  const urlInput = h('input', { type: 'text', placeholder: 'mysql://user:password@host:3306/database', spellcheck: false });
  urlInput.addEventListener('paste', () => setTimeout(() => {
    if (applyUrl(urlInput.value)) render();
  }));
  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && applyUrl(urlInput.value)) render();
  });

  const swatches = h(
    'div.swatches',
    null,
    COLORS.map((c) =>
      h(
        'button',
        {
          type: 'button',
          class: `swatch ${d.color === c.id ? 'selected' : ''} ${c.id ? '' : 'none'}`,
          title: c.label,
          style: { background: c.css },
          onclick: () => {
            d.color = c.id;
            render();
          },
        },
        c.id ? null : icon('circle-slash'),
      ),
    ),
  );

  const general = section('General', 'tag', [
    h('div.row', null, field('Connection name', text(() => d.name, (v) => (d.name = v), { placeholder: `${d.user || 'user'}@${d.host || 'host'}` }), undefined, 'grow'), field('Color', swatches)),
  ]);

  const server = section('Server', 'server', [
    h('div.row', null, field('Host', text(() => d.host, (v) => (d.host = v), { placeholder: '127.0.0.1' }), d.ssh.enabled ? 'As seen from the SSH server (often 127.0.0.1)' : undefined, 'grow'), field('Port', num(() => d.port, (v) => (d.port = v), { min: 1, max: 65535 }), undefined, 'port')),
    h('div.row', null, field('User', text(() => d.user, (v) => (d.user = v), { placeholder: 'root' }), undefined, 'grow'), field('Password', password(() => d.password, (v) => (d.password = v), d.savePassword ? '' : 'Asked when connecting'), undefined, 'grow')),
    checkbox('Save password', () => d.savePassword, (v) => (d.savePassword = v), 'Stored encrypted in the OS keychain through VS Code Secret Storage'),
    field('Default database', text(() => d.database, (v) => (d.database = v), { placeholder: 'optional' }), 'Used for new queries; all databases stay visible in the tree'),
  ], undefined, 'MySQL 5.7+, 8.x, 9.x and MariaDB');

  const sshAuth = h(
    'div.segmented',
    { role: 'radiogroup' },
    (['password', 'privateKey', 'agent'] as const).map((a) =>
      h(
        'button',
        {
          type: 'button',
          class: d.ssh.auth === a ? 'on' : '',
          onclick: () => {
            d.ssh.auth = a;
            render();
          },
        },
        a === 'password' ? 'Password' : a === 'privateKey' ? 'Private key' : 'SSH agent',
      ),
    ),
  );
  const sshBody = [
    h('div.row', null, field('SSH host', text(() => d.ssh.host, (v) => (d.ssh.host = v), { placeholder: 'bastion.example.com' }), undefined, 'grow'), field('Port', num(() => d.ssh.port, (v) => (d.ssh.port = v), { min: 1, max: 65535 }), undefined, 'port')),
    h('div.row', null, field('SSH user', text(() => d.ssh.user, (v) => (d.ssh.user = v), { placeholder: 'ubuntu' }), undefined, 'grow'), field('Authentication', sshAuth)),
    d.ssh.auth === 'password' ? field('SSH password', password(() => d.ssh.password, (v) => (d.ssh.password = v), d.savePassword ? '' : 'Asked when connecting')) : null,
    d.ssh.auth === 'privateKey'
      ? h('div.row', null, field('Private key file', fileInput('ssh.privateKeyPath', () => d.ssh.privateKeyPath, (v) => (d.ssh.privateKeyPath = v), 'empty = try ~/.ssh keys like ssh does'), 'Use the path as seen by VS Code (in WSL: ~/.ssh/id_rsa). ssh-agent and ~/.ssh/id_* are tried as a fallback.', 'grow'), field('Passphrase', password(() => d.ssh.passphrase, (v) => (d.ssh.passphrase = v), 'if the key has one'), undefined, 'grow'))
      : null,
    d.ssh.auth === 'agent' ? h('p.hint', null, 'Uses the running ssh-agent (SSH_AUTH_SOCK), then the default keys in ~/.ssh.') : null,
  ].filter(Boolean) as HTMLElement[];
  const ssh = section('SSH tunnel', 'remote', sshBody, { get: () => d.ssh.enabled, set: (v) => (d.ssh.enabled = v) }, 'Reach a database that only listens on a private network');

  const ssl = section('SSL / TLS', 'lock', [
    checkbox('Verify server certificate', () => d.ssl.rejectUnauthorized, (v) => (d.ssl.rejectUnauthorized = v), 'Turn off only for self-signed certificates you trust'),
    field('CA certificate', fileInput('ssl.ca', () => d.ssl.ca, (v) => (d.ssl.ca = v), 'optional — ca.pem')),
    h('div.row', null, field('Client certificate', fileInput('ssl.cert', () => d.ssl.cert, (v) => (d.ssl.cert = v), 'optional'), undefined, 'grow'), field('Client key', fileInput('ssl.key', () => d.ssl.key, (v) => (d.ssl.key = v), 'optional'), undefined, 'grow')),
  ], { get: () => d.ssl.enabled, set: (v) => (d.ssl.enabled = v) }, 'Required by most cloud databases');

  const advanced = section('Advanced', 'settings-gear', [
    checkbox('Read-only connection', () => d.readOnly, (v) => (d.readOnly = v), 'Sessions start with SET SESSION TRANSACTION READ ONLY; data editing and imports are disabled'),
    h('div.row', null, field('Connect timeout (seconds)', num(() => d.connectTimeout, (v) => (d.connectTimeout = v), { min: 1, max: 300 }), undefined, 'port wide')),
  ]);

  const saveBtn = h('button.btn', { type: 'button', disabled: busy, onclick: () => save(false) }, 'Save');
  const saveConnectBtn = h('button.btn', { type: 'button', disabled: busy, onclick: () => save(true) }, icon('plug'), 'Save & Connect');
  const testBtn = h('button.btn.secondary', { type: 'button', disabled: busy, onclick: test }, busy ? icon('loading', 'spin') : icon('debug-disconnect'), 'Test Connection');

  app.replaceChildren(
    h(
      'div.form-page',
      null,
      h(
        'div.form',
        null,
        h('header.form-head', null, h('div.logo', null, icon('database')), h('div', null, h('h1', null, isNew ? 'New Connection' : `Edit ${d.name || 'Connection'}`), h('p.muted', null, 'MySQL / MariaDB · unlimited connections'))),
        h('div.url-row', null, icon('link'), urlInput, h('span.hint', null, 'Paste a connection URL to fill the form')),
        general,
        server,
        ssh,
        ssl,
        advanced,
        saveError,
      ),
      h('footer.form-foot', null, h('div.foot-inner', null, testBtn, testResult, h('span.spacer'), h('button.btn.secondary', { type: 'button', onclick: () => send({ type: 'cancel' }) }, 'Cancel'), saveBtn, saveConnectBtn)),
    ),
  );
}

function test(): void {
  busy = true;
  testResult.className = 'test-result';
  testResult.replaceChildren(h('span.muted', null, 'Connecting…'));
  render();
  send({ type: 'test', data });
}

function save(connect: boolean): void {
  saveError.replaceChildren();
  send({ type: 'save', data, connect });
}

let isNew = true;

window.addEventListener('message', (ev: MessageEvent<FormToWebview>) => {
  const m = ev.data;
  switch (m.type) {
    case 'load':
      data = m.data;
      isNew = m.isNew;
      render();
      (document.querySelector('.field input') as HTMLInputElement | null)?.focus();
      break;
    case 'testResult':
      busy = false;
      testResult.className = `test-result ${m.ok ? 'ok' : 'err'}`;
      testResult.replaceChildren(icon(m.ok ? 'pass-filled' : 'error'), h('span', null, m.message));
      testResult.title = m.message;
      render();
      break;
    case 'pickedFile': {
      const [group, key] = m.field.split('.') as ['ssl' | 'ssh', string];
      (data[group] as unknown as Record<string, string>)[key] = m.path;
      render();
      break;
    }
    case 'saveError':
      saveError.replaceChildren(h('div.error-box', null, m.message));
      saveError.scrollIntoView({ behavior: 'smooth' });
      break;
  }
});

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    save(true);
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    save(false);
  }
});

send({ type: 'ready' });
