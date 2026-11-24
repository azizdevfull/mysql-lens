import * as vscode from 'vscode';
import { ConnectionStore } from '../connections/store';
import { ConnectionManager, testConnection } from '../connections/manager';
import { ConnectionConfig, defaultConfig } from '../connections/types';
import type { ConnectionFormData, FormToExtension, FormToWebview } from '../shared/protocol';
import { webviewHtml, webviewOptions } from './html';

const open = new Map<string, vscode.WebviewPanel>();

/** Opens the add/edit connection form. `id` edits an existing connection; `copyOf` duplicates one. */
export async function showConnectionForm(
  ctx: vscode.ExtensionContext,
  store: ConnectionStore,
  conns: ConnectionManager,
  opts: { id?: string; copyOf?: string } = {},
): Promise<void> {
  const key = opts.id ?? `new-${Date.now()}`;
  const existing = open.get(key);
  if (existing) {
    existing.reveal();
    return;
  }
  const source = opts.id ? store.get(opts.id) : opts.copyOf ? store.get(opts.copyOf) : undefined;
  const isNew = !opts.id;
  const data = await toFormData(store, source, isNew);
  if (opts.copyOf && source) {
    data.name = `${source.name} (copy)`;
  }

  const panel = vscode.window.createWebviewPanel(
    'mysqlLens.connection',
    isNew ? 'New Connection' : `Edit: ${source?.name}`,
    vscode.ViewColumn.Active,
    webviewOptions(ctx.extensionUri),
  );
  panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'media', 'panel.svg');
  panel.webview.html = webviewHtml(panel.webview, ctx.extensionUri, 'connection', 'Connection');
  open.set(key, panel);
  panel.onDidDispose(() => open.delete(key));

  const post = (m: FormToWebview) => panel.webview.postMessage(m);

  panel.webview.onDidReceiveMessage(async (m: FormToExtension) => {
    switch (m.type) {
      case 'ready':
        void post({ type: 'load', data, isNew });
        break;
      case 'cancel':
        panel.dispose();
        break;
      case 'pickFile': {
        const picked = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Select' });
        if (picked?.[0]) {
          void post({ type: 'pickedFile', field: m.field, path: picked[0].fsPath });
        }
        break;
      }
      case 'test': {
        try {
          const { config, secrets } = fromFormData(m.data);
          const version = await testConnection({ ...config, id: m.data.id ?? 'test' }, secrets);
          void post({ type: 'testResult', ok: true, message: `Connected. Server version ${version}` });
        } catch (e) {
          void post({ type: 'testResult', ok: false, message: errorText(e) });
        }
        break;
      }
      case 'save': {
        try {
          const { config, secrets } = fromFormData(m.data);
          if (!config.name.trim()) {
            config.name = `${config.user}@${config.host}`;
          }
          const saved = await store.save({ ...config, id: m.data.id });
          await store.setSecret(saved.id, 'password', config.savePassword ? secrets.password : undefined);
          await store.setSecret(saved.id, 'sshPassword', config.savePassword && config.ssh.auth === 'password' ? secrets.sshPassword : undefined);
          await store.setSecret(saved.id, 'sshPassphrase', config.ssh.auth === 'privateKey' ? secrets.sshPassphrase : undefined);
          // Settings changed: reconnect with the new ones next time.
          await conns.disconnect(saved.id);
          conns.forgetTypedSecrets(saved.id);
          panel.dispose();
          if (m.connect) {
            try {
              await conns.connect(saved.id);
            } catch (e) {
              void vscode.window.showErrorMessage(`MySQL Lens: ${saved.name}: ${errorText(e)}`);
            }
          }
        } catch (e) {
          void post({ type: 'saveError', message: errorText(e) });
        }
        break;
      }
    }
  });
}

async function toFormData(store: ConnectionStore, c: ConnectionConfig | undefined, isNew: boolean): Promise<ConnectionFormData> {
  const d = c ?? { ...defaultConfig(), id: '' };
  const secret = async (kind: 'password' | 'sshPassword' | 'sshPassphrase') => (c ? ((await store.getSecret(c.id, kind)) ?? '') : '');
  return {
    id: isNew ? undefined : d.id,
    name: d.name,
    color: d.color,
    host: d.host,
    port: d.port,
    user: d.user,
    password: await secret('password'),
    savePassword: d.savePassword,
    database: d.database ?? '',
    readOnly: d.readOnly,
    connectTimeout: d.connectTimeout,
    ssl: { enabled: d.ssl.enabled, rejectUnauthorized: d.ssl.rejectUnauthorized, ca: d.ssl.ca ?? '', cert: d.ssl.cert ?? '', key: d.ssl.key ?? '' },
    ssh: {
      enabled: d.ssh.enabled,
      host: d.ssh.host,
      port: d.ssh.port,
      user: d.ssh.user,
      auth: d.ssh.auth,
      password: await secret('sshPassword'),
      privateKeyPath: d.ssh.privateKeyPath ?? '',
      passphrase: await secret('sshPassphrase'),
    },
  };
}

function fromFormData(f: ConnectionFormData) {
  if (!f.host.trim()) {
    throw new Error('Host is required.');
  }
  if (f.ssh.enabled && (!f.ssh.host.trim() || !f.ssh.user.trim())) {
    throw new Error('SSH host and user are required when the SSH tunnel is on.');
  }
  const config: Omit<ConnectionConfig, 'id'> = {
    name: f.name.trim(),
    color: f.color,
    host: f.host.trim(),
    port: Number(f.port) || 3306,
    user: f.user.trim(),
    database: f.database.trim(),
    savePassword: f.savePassword,
    readOnly: f.readOnly,
    connectTimeout: Number(f.connectTimeout) || 10,
    ssl: {
      enabled: f.ssl.enabled,
      rejectUnauthorized: f.ssl.rejectUnauthorized,
      ca: f.ssl.ca.trim() || undefined,
      cert: f.ssl.cert.trim() || undefined,
      key: f.ssl.key.trim() || undefined,
    },
    ssh: {
      enabled: f.ssh.enabled,
      host: f.ssh.host.trim(),
      port: Number(f.ssh.port) || 22,
      user: f.ssh.user.trim(),
      auth: f.ssh.auth,
      privateKeyPath: f.ssh.privateKeyPath.trim() || undefined,
    },
  };
  return {
    config,
    secrets: {
      password: f.password,
      sshPassword: f.ssh.password,
      sshPassphrase: f.ssh.passphrase,
    },
  };
}

export function errorText(e: unknown): string {
  if (e instanceof Error) {
    const x = e as Error & { code?: string; sqlMessage?: string };
    if (x.code === 'ECONNREFUSED') {
      return `Connection refused (${x.message.replace(/^connect ECONNREFUSED /, '')}). Is the server running and the port open?`;
    }
    if (x.code === 'ETIMEDOUT') {
      return 'Connection timed out. Check host, port and firewall.';
    }
    if (x.code === 'ENOTFOUND') {
      return `Host not found: ${x.message.replace(/^getaddrinfo ENOTFOUND /, '')}`;
    }
    return x.sqlMessage ? `${x.code}: ${x.sqlMessage}` : x.message;
  }
  return String(e);
}
