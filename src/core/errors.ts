/** Human-readable text for driver, network and SSH errors. */
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

/** Minimal event emitter whose `event` is compatible with vscode.Event. */
export class Emitter<T> {
  private readonly listeners = new Set<(v: T) => void>();

  readonly event = (listener: (v: T) => void): { dispose(): void } => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  fire(v: T): void {
    for (const l of [...this.listeners]) {
      l(v);
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}
