import type { ConnectionManager } from '../connections/manager';
import { testConnection } from '../connections/driver';
import { ConnectionConfig, defaultConfig } from '../connections/types';
import type { ConnectionFormData, FormToExtension, FormToWebview } from '../shared/protocol';
import { errorText } from './errors';
import type { ConnectionStoreLike } from './flows';
import type { UiHost } from './host';

/** Add / edit / duplicate connection form. */
export class ConnectionFormController {
  private data?: ConnectionFormData;
  readonly isNew: boolean;

  constructor(
    private readonly host: UiHost,
    private readonly post: (m: FormToWebview) => void,
    private readonly store: ConnectionStoreLike,
    private readonly conns: ConnectionManager,
    private readonly opts: { id?: string; copyOf?: string },
    private readonly close: () => void,
  ) {
    this.isNew = !opts.id;
  }

  get title(): string {
    const src = this.opts.id ? this.store.get(this.opts.id) : undefined;
    return this.isNew ? 'New Connection' : `Edit: ${src?.name ?? ''}`;
  }

  async receive(m: FormToExtension): Promise<void> {
    switch (m.type) {
      case 'ready':
        this.data ??= await this.load();
        this.post({ type: 'load', data: this.data, isNew: this.isNew });
        return;
      case 'cancel':
        this.close();
        return;
      case 'pickFile': {
        const file = await this.host.openFile({ filters: { 'All files': ['*'] }, openLabel: 'Select' });
        if (file) this.post({ type: 'pickedFile', field: m.field, path: file });
        return;
      }
      case 'test':
        try {
          const { config, secrets } = fromFormData(m.data);
          const version = await testConnection({ ...config, id: m.data.id ?? 'test' }, secrets);
          this.post({ type: 'testResult', ok: true, message: `Connected. Server version ${version}` });
        } catch (e) {
          this.post({ type: 'testResult', ok: false, message: errorText(e) });
        }
        return;
      case 'save':
        try {
          const { config, secrets } = fromFormData(m.data);
          if (!config.name.trim()) config.name = `${config.user}@${config.host}`;
          const saved = await this.store.save({ ...config, id: m.data.id });
          await this.store.setSecret(saved.id, 'password', config.savePassword ? secrets.password : undefined);
          await this.store.setSecret(saved.id, 'sshPassword', config.savePassword && config.ssh.auth === 'password' ? secrets.sshPassword : undefined);
          await this.store.setSecret(saved.id, 'sshPassphrase', config.ssh.auth === 'privateKey' ? secrets.sshPassphrase : undefined);
          // Settings changed: reconnect with the new ones next time.
          await this.conns.disconnect(saved.id);
          this.conns.forgetTypedSecrets(saved.id);
          this.close();
          if (m.connect) {
            try {
              await this.conns.connect(saved.id);
            } catch (e) {
              this.host.error(`${saved.name}: ${errorText(e)}`);
            }
          }
        } catch (e) {
          this.post({ type: 'saveError', message: errorText(e) });
        }
        return;
    }
  }

  private async load(): Promise<ConnectionFormData> {
    const source = this.opts.id ? this.store.get(this.opts.id) : this.opts.copyOf ? this.store.get(this.opts.copyOf) : undefined;
    const d = source ?? { ...defaultConfig(), id: '' };
    const secret = async (kind: 'password' | 'sshPassword' | 'sshPassphrase') => (source ? ((await this.store.getSecret(source.id, kind)) ?? '') : '');
    return {
      id: this.isNew ? undefined : d.id,
      name: this.opts.copyOf && source ? `${source.name} (copy)` : d.name,
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
}

function fromFormData(f: ConnectionFormData) {
  if (!f.host.trim()) throw new Error('Host is required.');
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
  return { config, secrets: { password: f.password, sshPassword: f.ssh.password, sshPassphrase: f.ssh.passphrase } };
}
