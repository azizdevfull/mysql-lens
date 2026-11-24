import * as vscode from 'vscode';
import * as mysql from 'mysql2';
import { ConnectionStore } from './store';
import { Tunnel } from './tunnel';
import { ConnectionConfig } from './types';
import { buildOptions, connectOnce, openTunnelFor, QueryRows, runQuery, Secrets } from './driver';

export { buildOptions, runQuery, testConnection } from './driver';
export type { QueryRows, Secrets } from './driver';

interface Session {
  pool: mysql.Pool;
  tunnel?: Tunnel;
  serverVersion: string;
  /** Host/port the MySQL driver should dial (differs from config when tunneled). */
  host: string;
  port: number;
  options: mysql.ConnectionOptions;
}

export class ConnectionManager implements vscode.Disposable {
  private readonly sessions = new Map<string, Promise<Session>>();
  /** Passwords typed by the user for connections that do not save them. */
  private readonly typedSecrets = new Map<string, Secrets>();
  private readonly changed = new vscode.EventEmitter<string>();
  readonly onDidChangeState = this.changed.event;

  constructor(private readonly store: ConnectionStore) {}

  isConnected(id: string): boolean {
    return this.sessions.has(id);
  }

  async serverVersion(id: string): Promise<string> {
    return (await this.session(id)).serverVersion;
  }

  config(id: string): ConnectionConfig {
    const c = this.store.get(id);
    if (!c) {
      throw new Error('Connection no longer exists.');
    }
    return c;
  }

  async pool(id: string): Promise<mysql.Pool> {
    return (await this.session(id)).pool;
  }

  async query<T = QueryRows>(id: string, sql: string, values?: unknown[]): Promise<T> {
    return runQuery<T>(await this.pool(id), sql, values);
  }

  /**
   * Opens a dedicated connection (not from the pool) so session state such as
   * USE, SET and transactions stays with one editor.
   */
  async dedicated(id: string, database?: string): Promise<mysql.Connection> {
    const s = await this.session(id);
    const conn = await connectOnce({ ...s.options, host: s.host, port: s.port, database: database || undefined });
    if (this.config(id).readOnly) {
      await runQuery(conn, 'SET SESSION TRANSACTION READ ONLY');
    }
    return conn;
  }

  async connect(id: string): Promise<void> {
    await this.session(id);
  }

  async disconnect(id: string): Promise<void> {
    const p = this.sessions.get(id);
    if (!p) {
      return;
    }
    this.sessions.delete(id);
    this.changed.fire(id);
    try {
      const s = await p;
      await new Promise<void>((r) => s.pool.end(() => r()));
      s.tunnel?.close();
    } catch {
      // The session failed to open; nothing to close.
    }
  }

  /** Drops a typed (unsaved) password, e.g. after an access-denied error. */
  forgetTypedSecrets(id: string): void {
    this.typedSecrets.delete(id);
  }

  private session(id: string): Promise<Session> {
    let p = this.sessions.get(id);
    if (!p) {
      p = this.open(id);
      this.sessions.set(id, p);
      p.then(
        () => this.changed.fire(id),
        (err: unknown) => {
          this.sessions.delete(id);
          if ((err as { code?: string }).code === 'ER_ACCESS_DENIED_ERROR') {
            this.forgetTypedSecrets(id);
          }
          this.changed.fire(id);
        },
      );
    }
    return p;
  }

  async resolveSecrets(config: ConnectionConfig): Promise<Secrets> {
    const typed = this.typedSecrets.get(config.id) ?? {};
    const secrets: Secrets = {
      password: (await this.store.getSecret(config.id, 'password')) ?? typed.password,
      sshPassword: (await this.store.getSecret(config.id, 'sshPassword')) ?? typed.sshPassword,
      sshPassphrase: (await this.store.getSecret(config.id, 'sshPassphrase')) ?? typed.sshPassphrase,
    };
    if (!config.savePassword && secrets.password === undefined) {
      secrets.password = await askSecret(`MySQL password for ${config.user}@${config.host}`);
    }
    if (config.ssh.enabled && config.ssh.auth === 'password' && secrets.sshPassword === undefined) {
      secrets.sshPassword = await askSecret(`SSH password for ${config.ssh.user}@${config.ssh.host}`);
    }
    if (!config.savePassword) {
      this.typedSecrets.set(config.id, secrets);
    }
    return secrets;
  }

  private async open(id: string): Promise<Session> {
    const config = this.config(id);
    const secrets = await this.resolveSecrets(config);
    const tunnel = await openTunnelFor(config, secrets, () => {
      if (this.sessions.has(id)) {
        void this.disconnect(id);
        void vscode.window.showWarningMessage(`MySQL Studio: SSH tunnel for "${config.name}" closed.`);
      }
    });
    try {
      const options = await buildOptions(config, secrets);
      const host = tunnel ? '127.0.0.1' : config.host;
      const port = tunnel ? tunnel.localPort : config.port;
      const pool = mysql.createPool({
        ...options,
        host,
        port,
        database: config.database || undefined,
        connectionLimit: 4,
        maxIdle: 2,
        idleTimeout: 60000,
      });
      if (config.readOnly) {
        pool.on('connection', (c) => c.query('SET SESSION TRANSACTION READ ONLY'));
      }
      const rows = await runQuery<{ v: string }[]>(pool, 'SELECT VERSION() AS v');
      return { pool, tunnel, serverVersion: rows[0]?.v ?? '', host, port, options };
    } catch (e) {
      tunnel?.close();
      throw e;
    }
  }

  dispose(): void {
    for (const id of [...this.sessions.keys()]) {
      void this.disconnect(id);
    }
  }
}

async function askSecret(prompt: string): Promise<string> {
  const v = await vscode.window.showInputBox({ prompt, password: true, ignoreFocusOut: true });
  if (v === undefined) {
    throw new Error('Cancelled.');
  }
  return v;
}
