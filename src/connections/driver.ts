import { readFile } from 'node:fs/promises';
import * as mysql from 'mysql2';
import { ConnectionConfig } from './types';
import { openTunnel, Tunnel, expandHome } from './tunnel';

/* MySQL driver helpers. No dependency on the vscode module, so tests can use them. */

export interface Secrets {
  password?: string;
  sshPassword?: string;
  sshPassphrase?: string;
}

export type QueryRows = Record<string, unknown>[];

/** Converts JSON columns to text so they round-trip unchanged. */
const typeCast: mysql.TypeCast = (field, next) => {
  if (field.type === 'JSON') {
    return field.string('utf8');
  }
  return next();
};

export async function buildOptions(config: ConnectionConfig, secrets: Secrets): Promise<mysql.ConnectionOptions> {
  const opts: mysql.ConnectionOptions = {
    host: config.host,
    port: config.port,
    user: config.user,
    password: secrets.password ?? '',
    connectTimeout: Math.max(1, config.connectTimeout || 10) * 1000,
    charset: 'utf8mb4_unicode_ci',
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    decimalNumbers: false,
    multipleStatements: false,
    enableKeepAlive: true,
    typeCast,
  };
  if (config.ssl.enabled) {
    const ssl: Record<string, unknown> = { rejectUnauthorized: config.ssl.rejectUnauthorized };
    for (const k of ['ca', 'cert', 'key'] as const) {
      const p = config.ssl[k];
      if (p) {
        ssl[k] = await readFile(expandHome(p), 'utf8');
      }
    }
    opts.ssl = ssl as mysql.SslOptions;
  }
  return opts;
}

export async function openTunnelFor(config: ConnectionConfig, secrets: Secrets, onClose: () => void): Promise<Tunnel | undefined> {
  if (!config.ssh.enabled) {
    return undefined;
  }
  return openTunnel(
    config.ssh,
    { password: secrets.sshPassword, passphrase: secrets.sshPassphrase },
    config.host,
    config.port,
    config.connectTimeout,
    onClose,
  );
}

export function connectOnce(opts: mysql.ConnectionOptions): Promise<mysql.Connection> {
  return new Promise((resolve, reject) => {
    const c = mysql.createConnection(opts);
    c.connect((err) => (err ? reject(err) : resolve(c)));
  });
}

export function runQuery<T = QueryRows>(conn: mysql.Connection | mysql.Pool | mysql.PoolConnection, sql: string, values?: unknown[]): Promise<T> {
  return new Promise((resolve, reject) => {
    conn.query(sql, values ?? [], (err, rows) => (err ? reject(err) : resolve(rows as T)));
  });
}

/** Opens a short-lived connection to check the settings. Returns the server version. */
export async function testConnection(config: ConnectionConfig, secrets: Secrets): Promise<string> {
  const tunnel = await openTunnelFor(config, secrets, () => undefined);
  try {
    const opts = await buildOptions(config, secrets);
    if (tunnel) {
      opts.host = '127.0.0.1';
      opts.port = tunnel.localPort;
    }
    if (config.database) {
      opts.database = config.database;
    }
    const conn = await connectOnce(opts);
    try {
      const rows = await runQuery<{ v: string }[]>(conn, 'SELECT VERSION() AS v');
      return rows[0]?.v ?? 'unknown';
    } finally {
      conn.destroy();
    }
  } finally {
    tunnel?.close();
  }
}

