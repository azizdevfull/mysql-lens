import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { ConnectionConfig, defaultConfig } from './types';

const KEY = 'mysqlLens.connections';

import type { SecretKind } from './manager';
export type { SecretKind };

/** Persists connection settings in globalState and secrets in SecretStorage. */
export class ConnectionStore {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  list(): ConnectionConfig[] {
    const raw = this.ctx.globalState.get<ConnectionConfig[]>(KEY, []);
    // Fill fields added in later versions so old entries keep working.
    return raw.map((c) => ({ ...defaultConfig(), ...c, ssl: { ...defaultConfig().ssl, ...c.ssl }, ssh: { ...defaultConfig().ssh, ...c.ssh } }));
  }

  get(id: string): ConnectionConfig | undefined {
    return this.list().find((c) => c.id === id);
  }

  async save(config: Omit<ConnectionConfig, 'id'> & { id?: string }): Promise<ConnectionConfig> {
    const all = this.list();
    const full: ConnectionConfig = { ...config, id: config.id || randomUUID() };
    const i = all.findIndex((c) => c.id === full.id);
    if (i >= 0) {
      all[i] = full;
    } else {
      all.push(full);
    }
    await this.ctx.globalState.update(KEY, all);
    this.changed.fire();
    return full;
  }

  async remove(id: string): Promise<void> {
    await this.ctx.globalState.update(
      KEY,
      this.list().filter((c) => c.id !== id),
    );
    await Promise.all((['password', 'sshPassword', 'sshPassphrase'] as SecretKind[]).map((k) => this.deleteSecret(id, k)));
    this.changed.fire();
  }

  async reorder(ids: string[]): Promise<void> {
    const all = this.list();
    all.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
    await this.ctx.globalState.update(KEY, all);
    this.changed.fire();
  }

  getSecret(id: string, kind: SecretKind): Thenable<string | undefined> {
    return this.ctx.secrets.get(`mysqlLens.${kind}.${id}`);
  }

  async setSecret(id: string, kind: SecretKind, value: string | undefined): Promise<void> {
    if (value) {
      await this.ctx.secrets.store(`mysqlLens.${kind}.${id}`, value);
    } else {
      await this.deleteSecret(id, kind);
    }
  }

  private async deleteSecret(id: string, kind: SecretKind): Promise<void> {
    await this.ctx.secrets.delete(`mysqlLens.${kind}.${id}`);
  }
}
