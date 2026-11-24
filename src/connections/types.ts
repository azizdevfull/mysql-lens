export interface SslConfig {
  enabled: boolean;
  rejectUnauthorized: boolean;
  /** Paths to PEM files. */
  ca?: string;
  cert?: string;
  key?: string;
}

export interface SshConfig {
  enabled: boolean;
  host: string;
  port: number;
  user: string;
  auth: 'password' | 'privateKey' | 'agent';
  privateKeyPath?: string;
}

/** Connection settings stored in globalState. Secrets live in SecretStorage. */
export interface ConnectionConfig {
  id: string;
  name: string;
  color: string;
  host: string;
  port: number;
  user: string;
  database?: string;
  savePassword: boolean;
  readOnly: boolean;
  connectTimeout: number;
  ssl: SslConfig;
  ssh: SshConfig;
}

export const COLORS = ['', 'charts.red', 'charts.orange', 'charts.yellow', 'charts.green', 'charts.blue', 'charts.purple'];

export function defaultConfig(): Omit<ConnectionConfig, 'id'> {
  return {
    name: '',
    color: '',
    host: '127.0.0.1',
    port: 3306,
    user: 'root',
    database: '',
    savePassword: true,
    readOnly: false,
    connectTimeout: 10,
    ssl: { enabled: false, rejectUnauthorized: true },
    ssh: { enabled: false, host: '', port: 22, user: '', auth: 'password' },
  };
}

export function describe(c: ConnectionConfig): string {
  const base = `${c.user}@${c.host}:${c.port}`;
  return c.ssh.enabled ? `${base} via ${c.ssh.host}` : base;
}
