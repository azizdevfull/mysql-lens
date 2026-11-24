import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { app, safeStorage } from 'electron';
import { ConnectionConfig, defaultConfig } from '../../src/connections/types';
import type { SecretKind } from '../../src/connections/manager';
import type { ConnectionStoreLike } from '../../src/core/flows';
import { Emitter } from '../../src/core/errors';

/** Small JSON file in the user data folder, written atomically. */
export class JsonFile<T> {
  private readonly file: string;

  constructor(name: string, private readonly fallback: T) {
    this.file = path.join(app.getPath('userData'), name);
  }

  read(): T {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8')) as T;
    } catch {
      return structuredClone(this.fallback);
    }
  }

  write(value: T): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

/**
 * Connections in connections.json; passwords in secrets.json, encrypted with
 * Electron safeStorage (DPAPI on Windows, Keychain on macOS, libsecret on Linux).
 */
export class DesktopStore implements ConnectionStoreLike {
  private readonly conns = new JsonFile<ConnectionConfig[]>('connections.json', []);
  private readonly secrets = new JsonFile<Record<string, string>>('secrets.json', {});
  private readonly changed = new Emitter<void>();
  readonly onDidChange = this.changed.event;

  list(): ConnectionConfig[] {
    const base = defaultConfig();
    return this.conns.read().map((c) => ({ ...base, ...c, ssl: { ...base.ssl, ...c.ssl }, ssh: { ...base.ssh, ...c.ssh } }));
  }

  get(id: string): ConnectionConfig | undefined {
    return this.list().find((c) => c.id === id);
  }

  async save(config: Omit<ConnectionConfig, 'id'> & { id?: string }): Promise<ConnectionConfig> {
    const all = this.list();
    const full: ConnectionConfig = { ...config, id: config.id || randomUUID() };
    const i = all.findIndex((c) => c.id === full.id);
    if (i >= 0) all[i] = full;
    else all.push(full);
    this.conns.write(all);
    this.changed.fire();
    return full;
  }

  async remove(id: string): Promise<void> {
    this.conns.write(this.list().filter((c) => c.id !== id));
    const s = this.secrets.read();
    for (const k of Object.keys(s)) {
      if (k.endsWith(`.${id}`)) delete s[k];
    }
    this.secrets.write(s);
    this.changed.fire();
  }

  async reorder(ids: string[]): Promise<void> {
    const all = this.list();
    all.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
    this.conns.write(all);
    this.changed.fire();
  }

  async getSecret(id: string, kind: SecretKind): Promise<string | undefined> {
    const v = this.secrets.read()[`${kind}.${id}`];
    if (!v) return undefined;
    try {
      return safeStorage.isEncryptionAvailable() && v.startsWith('enc:') ? safeStorage.decryptString(Buffer.from(v.slice(4), 'base64')) : undefined;
    } catch {
      return undefined;
    }
  }

  async setSecret(id: string, kind: SecretKind, value: string | undefined): Promise<void> {
    const s = this.secrets.read();
    const key = `${kind}.${id}`;
    if (value && safeStorage.isEncryptionAvailable()) {
      s[key] = 'enc:' + safeStorage.encryptString(value).toString('base64');
    } else {
      delete s[key];
    }
    this.secrets.write(s);
  }
}
