import * as net from 'node:net';
import { readFile } from 'node:fs/promises';
import { AgentAuthMethod, AuthMethod, Client, ConnectConfig, PasswordAuthMethod, PublicKeyAuthMethod, utils } from 'ssh2';
import { SshConfig } from './types';

export interface SshSecrets {
  password?: string;
  passphrase?: string;
}

export interface Tunnel {
  localPort: number;
  close(): void;
}

/**
 * Opens an SSH connection and a local TCP server on 127.0.0.1:<random port>.
 * Every socket accepted locally is forwarded to dstHost:dstPort through SSH.
 */
export async function openTunnel(
  ssh: SshConfig,
  secrets: SshSecrets,
  dstHost: string,
  dstPort: number,
  timeoutSec: number,
  onClose: () => void,
): Promise<Tunnel> {
  const cfg: ConnectConfig = {
    host: ssh.host,
    port: ssh.port || 22,
    username: ssh.user,
    readyTimeout: Math.max(5, timeoutSec) * 1000,
    keepaliveInterval: 15000,
    keepaliveCountMax: 4,
  };
  const { methods, tried } = await authMethods(ssh, secrets);
  if (!methods.length) {
    throw new Error(
      ssh.auth === 'agent'
        ? 'SSH agent is not available (SSH_AUTH_SOCK is not set) and no key was found in ~/.ssh.'
        : 'No usable SSH key found. Choose a private key file.',
    );
  }
  cfg.authHandler = methods;

  const client = new Client();
  await new Promise<void>((resolve, reject) => {
    client.once('ready', resolve);
    client.once('error', (e) => {
      const authFailed = /authentication methods failed/i.test(e.message);
      reject(new Error(authFailed ? `SSH: server ${ssh.user}@${ssh.host} rejected ${tried.join(', ')}` : `SSH: ${e.message}`));
    });
    client.connect(cfg);
  });

  let closed = false;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    client.forwardOut('127.0.0.1', socket.remotePort ?? 0, dstHost, dstPort, (err, stream) => {
      if (err) {
        socket.destroy(err);
        return;
      }
      socket.pipe(stream).pipe(socket);
      stream.on('error', () => socket.destroy());
      socket.on('error', () => stream.destroy());
    });
  });

  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    for (const s of sockets) {
      s.destroy();
    }
    server.close();
    client.end();
    onClose();
  };
  client.on('close', close);
  client.on('error', close);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as net.AddressInfo;
  return { localPort: address.port, close };
}

/** Key files OpenSSH tries by default, in its order. */
const DEFAULT_KEYS = ['id_rsa', 'id_ecdsa', 'id_ecdsa_sk', 'id_ed25519', 'id_ed25519_sk', 'id_dsa'];

/**
 * Authentication attempts in the order `ssh` itself would use them: the chosen
 * method first, then the agent and the default keys in ~/.ssh. Keys that are
 * encrypted and have no passphrase are skipped.
 */
export async function authMethods(ssh: SshConfig, secrets: SshSecrets): Promise<{ methods: AuthMethod[]; tried: string[] }> {
  const username = ssh.user;
  const methods: AuthMethod[] = [];
  const tried: string[] = [];
  const seen = new Set<string>();

  const addKey = async (file: string, passphrase?: string): Promise<void> => {
    const full = expandHome(file);
    if (seen.has(full)) {
      return;
    }
    seen.add(full);
    let key: Buffer;
    try {
      key = await readFile(full);
    } catch {
      if (file === ssh.privateKeyPath) {
        throw new Error(`Cannot read SSH key file ${file}`);
      }
      return;
    }
    const parsed = utils.parseKey(key, passphrase);
    if (parsed instanceof Error) {
      if (file === ssh.privateKeyPath) {
        throw new Error(/passphrase/i.test(parsed.message) ? `SSH key ${file} is encrypted: enter its passphrase.` : `SSH key ${file}: ${parsed.message}`);
      }
      return;
    }
    methods.push({ type: 'publickey', username, key, passphrase } as PublicKeyAuthMethod);
    tried.push(file.replace(/^\/home\/[^/]+|^\/root/, '~'));
  };
  const addAgent = () => {
    if (process.env.SSH_AUTH_SOCK) {
      methods.push({ type: 'agent', username, agent: process.env.SSH_AUTH_SOCK } as AgentAuthMethod);
      tried.push('ssh-agent');
    }
  };

  if (ssh.auth === 'password') {
    methods.push({ type: 'password', username, password: secrets.password ?? '' } as PasswordAuthMethod);
    tried.push('password');
    return { methods, tried };
  }
  if (ssh.auth === 'privateKey' && ssh.privateKeyPath) {
    await addKey(ssh.privateKeyPath, secrets.passphrase || undefined);
  }
  addAgent();
  for (const k of DEFAULT_KEYS) {
    await addKey(`~/.ssh/${k}`);
  }
  return { methods, tried };
}

export function expandHome(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return (process.env.HOME || process.env.USERPROFILE || '') + p.slice(1);
  }
  return p;
}
