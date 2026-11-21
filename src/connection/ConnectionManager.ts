import * as fs from 'fs';
import * as vscode from 'vscode';
import * as mysql from 'mysql2/promise';
import type { ConnectionProfile, ConnectionState, SslMode } from '../../shared/types';

export interface ActiveConnection {
  profile: ConnectionProfile;
  pool: mysql.Pool;
  state: ConnectionState;
  lastError?: string;
}

function sslOptions(profile: ConnectionProfile): mysql.SslOptions | undefined {
  if (profile.sslMode === 'disable') {
    return undefined;
  }
  const opts: mysql.SslOptions = {};
  if (profile.sslCaPath) {
    opts.ca = fs.readFileSync(profile.sslCaPath);
  }
  if (profile.sslCertPath) {
    opts.cert = fs.readFileSync(profile.sslCertPath);
  }
  if (profile.sslKeyPath) {
    opts.key = fs.readFileSync(profile.sslKeyPath);
  }
  if (profile.sslMode === 'required' || profile.sslMode === 'preferred') {
    opts.rejectUnauthorized = false;
  }
  if (profile.sslMode === 'verify-ca' || profile.sslMode === 'verify-identity') {
    opts.rejectUnauthorized = true;
  }
  return opts;
}

export class ConnectionManager {
  private readonly profiles = new Map<string, ConnectionProfile>();
  private readonly active = new Map<string, ActiveConnection>();
  private readonly secrets: vscode.SecretStorage;
  private readonly globalState: vscode.Memento;
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.onDidChangeEmitter.event;
  private reconnectTimers = new Map<string, NodeJS.Timeout>();

  constructor(context: vscode.ExtensionContext) {
    this.secrets = context.secrets;
    this.globalState = context.globalState;
    const saved = this.globalState.get<ConnectionProfile[]>('erdWorkbench.profiles', []);
    for (const p of saved) {
      this.profiles.set(p.id, p);
    }
  }

  listProfiles(): ConnectionProfile[] {
    return [...this.profiles.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  getProfile(id: string): ConnectionProfile | undefined {
    return this.profiles.get(id);
  }

  getActive(id: string): ActiveConnection | undefined {
    return this.active.get(id);
  }

  isConnected(id: string): boolean {
    return this.active.get(id)?.state === 'connected';
  }

  private async persistProfiles(): Promise<void> {
    await this.globalState.update('erdWorkbench.profiles', this.listProfiles());
    this.onDidChangeEmitter.fire();
  }

  async upsertProfile(profile: ConnectionProfile, password?: string): Promise<void> {
    this.profiles.set(profile.id, profile);
    if (password !== undefined) {
      await this.secrets.store(this.passwordKey(profile.id), password);
    }
    await this.persistProfiles();
  }

  async deleteProfile(id: string): Promise<void> {
    await this.disconnect(id);
    this.profiles.delete(id);
    await this.secrets.delete(this.passwordKey(id));
    await this.persistProfiles();
  }

  private passwordKey(id: string): string {
    return `erdWorkbench.password.${id}`;
  }

  async getPassword(id: string): Promise<string | undefined> {
    return this.secrets.get(this.passwordKey(id));
  }

  async testConnection(profile: ConnectionProfile, password: string): Promise<void> {
    const conn = await mysql.createConnection(this.buildConfig(profile, password));
    try {
      await conn.query('SELECT 1');
    } finally {
      await conn.end();
    }
  }

  async connect(id: string, password?: string): Promise<ActiveConnection> {
    const profile = this.profiles.get(id);
    if (!profile) {
      throw new Error(`Unknown connection: ${id}`);
    }
    const pwd = password ?? (await this.getPassword(id));
    if (pwd === undefined) {
      throw new Error('Password not found. Edit the connection to set a password.');
    }

    await this.disconnect(id);

    const pool = mysql.createPool({
      ...this.buildConfig(profile, pwd),
      waitForConnections: true,
      connectionLimit: 5,
      enableKeepAlive: true,
      maxIdle: 2,
      idleTimeout: 60000,
    });

    const active: ActiveConnection = { profile, pool, state: 'connecting' };
    this.active.set(id, active);

    try {
      const conn = await pool.getConnection();
      await conn.query('SELECT 1');
      conn.release();
      active.state = 'connected';
      this.onDidChangeEmitter.fire();
      return active;
    } catch (err) {
      active.state = 'error';
      active.lastError = err instanceof Error ? err.message : String(err);
      await pool.end().catch(() => undefined);
      this.active.delete(id);
      this.onDidChangeEmitter.fire();
      throw err;
    }
  }

  async disconnect(id: string): Promise<void> {
    const timer = this.reconnectTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(id);
    }
    const active = this.active.get(id);
    if (!active) {
      return;
    }
    this.active.delete(id);
    await active.pool.end().catch(() => undefined);
    this.onDidChangeEmitter.fire();
  }

  async query<T extends mysql.RowDataPacket[] = mysql.RowDataPacket[]>(
    connectionId: string,
    sql: string,
    params?: unknown[]
  ): Promise<[T, mysql.FieldPacket[]]> {
    const active = this.active.get(connectionId);
    if (!active || active.state !== 'connected') {
      throw new Error('Not connected');
    }
    try {
      return (await active.pool.query<T>(sql, params)) as [T, mysql.FieldPacket[]];
    } catch (err) {
      await this.handleQueryError(connectionId, err);
      throw err;
    }
  }

  async getConnection(connectionId: string): Promise<mysql.PoolConnection> {
    const active = this.active.get(connectionId);
    if (!active || active.state !== 'connected') {
      throw new Error('Not connected');
    }
    try {
      return await active.pool.getConnection();
    } catch (err) {
      await this.handleQueryError(connectionId, err);
      throw err;
    }
  }

  private async handleQueryError(connectionId: string, err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    const lost =
      /PROTOCOL_CONNECTION_LOST|ECONNRESET|ECONNREFUSED|Cannot enqueue|Connection lost|server has gone away/i.test(
        message
      );
    if (!lost) {
      return;
    }
    const active = this.active.get(connectionId);
    if (!active) {
      return;
    }
    active.state = 'error';
    active.lastError = message;
    this.onDidChangeEmitter.fire();

    const auto = vscode.workspace.getConfiguration('erdWorkbench').get<boolean>('autoReconnect', true);
    if (auto) {
      void this.scheduleReconnect(connectionId);
    }
  }

  private scheduleReconnect(connectionId: string, attempt = 1): void {
    if (attempt > 5) {
      return;
    }
    const delay = Math.min(1000 * 2 ** (attempt - 1), 15000);
    const existing = this.reconnectTimers.get(connectionId);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(async () => {
      const active = this.active.get(connectionId);
      if (!active) {
        return;
      }
      active.state = 'reconnecting';
      this.onDidChangeEmitter.fire();
      try {
        await this.connect(connectionId);
        vscode.window.showInformationMessage(`Reconnected: ${active.profile.name}`);
      } catch {
        this.scheduleReconnect(connectionId, attempt + 1);
      }
    }, delay);
    this.reconnectTimers.set(connectionId, timer);
  }

  private buildConfig(profile: ConnectionProfile, password: string): mysql.PoolOptions {
    const ssl = sslOptions(profile);
    return {
      host: profile.host,
      port: profile.port,
      user: profile.user,
      password,
      database: profile.database || undefined,
      multipleStatements: false,
      ssl: profile.sslMode === 'disable' ? undefined : ssl,
      connectTimeout: 15000,
    };
  }

  async promptNewProfile(): Promise<ConnectionProfile | undefined> {
    const name = await vscode.window.showInputBox({ prompt: 'Connection name', value: 'Local MySQL' });
    if (!name) {
      return undefined;
    }
    const host = await vscode.window.showInputBox({ prompt: 'Host', value: '127.0.0.1' });
    if (!host) {
      return undefined;
    }
    const portStr = await vscode.window.showInputBox({ prompt: 'Port', value: '3306' });
    if (!portStr) {
      return undefined;
    }
    const user = await vscode.window.showInputBox({ prompt: 'User', value: 'root' });
    if (!user) {
      return undefined;
    }
    const password = await vscode.window.showInputBox({ prompt: 'Password', password: true });
    if (password === undefined) {
      return undefined;
    }
    const database = await vscode.window.showInputBox({
      prompt: 'Default database (optional)',
      value: '',
    });
    const sslDefault = vscode.workspace
      .getConfiguration('erdWorkbench')
      .get<SslMode>('sslDefaultMode', 'preferred');
    const sslMode = (await vscode.window.showQuickPick(
      ['disable', 'preferred', 'required', 'verify-ca', 'verify-identity'] as SslMode[],
      { placeHolder: 'SSL mode', title: 'SSL' }
    )) as SslMode | undefined;
    if (!sslMode) {
      return undefined;
    }

    const profile: ConnectionProfile = {
      id: `conn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      name,
      host,
      port: Number(portStr) || 3306,
      user,
      database: database || undefined,
      sslMode: sslMode || sslDefault,
    };

    try {
      await this.testConnection(profile, password);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const choice = await vscode.window.showWarningMessage(
        `Connection test failed: ${msg}. Save anyway?`,
        'Save',
        'Cancel'
      );
      if (choice !== 'Save') {
        return undefined;
      }
    }

    await this.upsertProfile(profile, password);
    return profile;
  }

  dispose(): void {
    for (const timer of this.reconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.reconnectTimers.clear();
    for (const id of [...this.active.keys()]) {
      void this.disconnect(id);
    }
    this.onDidChangeEmitter.dispose();
  }
}
