import type { FieldPacket, RowDataPacket } from 'mysql2';
import { ConnectionManager } from '../../connection/ConnectionManager';
import { SqlPolicyGate, type GateRequest } from '../policy/SqlPolicyGate';

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  affectedRows?: number;
  truncated: boolean;
  risk: string;
}

const MAX_ROWS = 1000;

/**
 * Only entry point that runs SQL against the database.
 * Always goes through SqlPolicyGate first.
 */
export class SqlExecutionService {
  constructor(
    private readonly connections: ConnectionManager,
    private readonly gate: SqlPolicyGate
  ) {}

  async execute(
    connectionId: string,
    sql: string,
    source: GateRequest['source'],
    options?: { approvalContentHash?: string; maxRows?: number }
  ): Promise<QueryResult> {
    const decision = await this.gate.authorizeOrConfirm({
      sql,
      source,
      approvalContentHash: options?.approvalContentHash,
    });

    if (!decision.allowed) {
      throw new Error(decision.reason ?? 'SQL execution denied by policy gate');
    }

    // Execute one statement at a time (pool has multipleStatements: false)
    const maxRows = options?.maxRows ?? MAX_ROWS;
    let last: QueryResult = {
      columns: [],
      rows: [],
      truncated: false,
      risk: decision.risk,
    };

    for (const stmt of decision.statements) {
      const [rows, fields] = await this.connections.query<RowDataPacket[]>(
        connectionId,
        stmt.sql
      );
      if (Array.isArray(rows)) {
        const list = rows as RowDataPacket[];
        const truncated = list.length > maxRows;
        const sliced = truncated ? list.slice(0, maxRows) : list;
        const columns =
          fields?.map((f: FieldPacket) => f.name) ??
          (sliced[0] ? Object.keys(sliced[0]) : []);
        last = {
          columns,
          rows: sliced as Record<string, unknown>[],
          truncated,
          risk: decision.risk,
        };
      } else {
        const header = rows as unknown as { affectedRows?: number };
        last = {
          columns: [],
          rows: [],
          affectedRows: header.affectedRows,
          truncated: false,
          risk: decision.risk,
        };
      }
    }
    return last;
  }
}
