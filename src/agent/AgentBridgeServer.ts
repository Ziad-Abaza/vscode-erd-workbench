import * as http from 'http';
import * as vscode from 'vscode';
import { McpToolHost } from '../mcp/McpToolHost';

/**
 * Localhost JSON API for CLI / external agents while VS Code is open.
 * Default: http://127.0.0.1:3847
 *
 * POST /invoke  { "tool": "set_table_positions", "args": { ... } }
 * GET  /tools
 * GET  /health
 */
export class AgentBridgeServer {
  private server: http.Server | undefined;
  private port = 3847;

  constructor(private readonly mcp: McpToolHost) {}

  async start(): Promise<number> {
    const configPort = vscode.workspace
      .getConfiguration('erdWorkbench')
      .get<number>('agentBridgePort', 3847);
    this.port = configPort;

    if (this.server) {
      return this.port;
    }

    this.server = http.createServer(async (req, res) => {
      setCors(res);
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      try {
        if (req.method === 'GET' && req.url === '/health') {
          json(res, 200, { ok: true, service: 'erd-workbench-agent-bridge' });
          return;
        }
        if (req.method === 'GET' && req.url === '/tools') {
          json(res, 200, { tools: this.mcp.listTools() });
          return;
        }
        if (req.method === 'POST' && req.url === '/invoke') {
          const body = await readBody(req);
          const tool = String(body.tool ?? '');
          const args = (body.args ?? {}) as Record<string, unknown>;
          if (!tool) {
            json(res, 400, { error: 'Missing tool' });
            return;
          }
          const result = await this.mcp.invoke(tool, args);
          json(res, 200, { ok: true, result });
          return;
        }
        json(res, 404, { error: 'Not found' });
      } catch (err) {
        json(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.port, '127.0.0.1', () => resolve());
    });

    return this.port;
  }

  dispose(): void {
    this.server?.close();
    this.server = undefined;
  }
}

function setCors(res: http.ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function json(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body, null, 2));
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(Buffer.from(c)));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8') || '{}';
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}
