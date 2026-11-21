import type { FieldPacket, RowDataPacket } from 'mysql2';
import type { QueryResult, SqlRiskClass } from '../../../shared/types';
import { ConnectionManager } from '../../connection/ConnectionManager';
import { SqlPolicyGate, type GateRequest } from '../policy/SqlPolicyGate';
import { isQueryCancelledError, QueryCancelledError } from './QueryCancelledError';

export type { QueryResult };

export interface SqlExecuteOptions {
  approvalContentHash?: string;
  maxRows?: number;
  signal?: AbortSignal;
  /** Called after each statement finishes (for multi-statement progress). */
  onStatementComplete?: (index: number, total: number, result: QueryResult) => void;
}

export interface SqlExecuteOutcome {
  results: QueryResult[];
  risk: SqlRiskClass;
  totalDurationMs: number;
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
    options?: SqlExecuteOptions
  ): Promise<QueryResult> {
    const outcome = await this.executeAll(connectionId, sql, source, options);
    return (
      outcome.results[outcome.results.length - 1] ?? {
        columns: [],
        rows: [],
        truncated: false,
        risk: outcome.risk,
      }
    );
  }

  /**
   * Execute all statements and return every result set (for the Results panel).
   * Supports AbortSignal cancellation between and during statements.
   */
  async executeAll(
    connectionId: string,
    sql: string,
    source: GateRequest['source'],
    options?: SqlExecuteOptions
  ): Promise<SqlExecuteOutcome> {
    const decision = await this.gate.authorizeOrConfirm({
      sql,
      source,
      approvalContentHash: options?.approvalContentHash,
    });

    if (!decision.allowed) {
      throw new Error(decision.reason ?? 'SQL execution denied by policy gate');
    }

    if (options?.signal?.aborted) {
      throw new QueryCancelledError();
    }

    const maxRows = options?.maxRows ?? MAX_ROWS;
    const results: QueryResult[] = [];
    const started = Date.now();
    const statements = decision.statements;

    for (let i = 0; i < statements.length; i++) {
      if (options?.signal?.aborted) {
        throw new QueryCancelledError();
      }
      const stmt = statements[i];
      const stmtStarted = Date.now();
      try {
        const [rows, fields] = await this.connections.queryCancellable<RowDataPacket[]>(
          connectionId,
          stmt.sql,
          { signal: options?.signal }
        );
        const result = materializeResult(rows, fields, decision.risk, maxRows, stmt.sql, stmtStarted);
        results.push(result);
        options?.onStatementComplete?.(i, statements.length, result);
      } catch (err) {
        if (isQueryCancelledError(err) || options?.signal?.aborted) {
          throw new QueryCancelledError();
        }
        throw err;
      }
    }

    return {
      results,
      risk: decision.risk,
      totalDurationMs: Date.now() - started,
    };
  }
}

function materializeResult(
  rows: RowDataPacket[] | RowDataPacket,
  fields: FieldPacket[] | undefined,
  risk: SqlRiskClass,
  maxRows: number,
  statementSql: string,
  stmtStarted: number
): QueryResult {
  const durationMs = Date.now() - stmtStarted;
  if (Array.isArray(rows)) {
    const list = rows as RowDataPacket[];
    const truncated = list.length > maxRows;
    const sliced = truncated ? list.slice(0, maxRows) : list;
    const columns =
      fields?.map((f: FieldPacket) => f.name) ?? (sliced[0] ? Object.keys(sliced[0]) : []);
    return {
      columns,
      rows: sliced.map(serializeRow),
      truncated,
      risk,
      statementSql,
      durationMs,
    };
  }
  const header = rows as unknown as { affectedRows?: number };
  return {
    columns: [],
    rows: [],
    affectedRows: header.affectedRows,
    truncated: false,
    risk,
    statementSql,
    durationMs,
  };
}

/** JSON-safe cell values for the Results webview. */
function serializeRow(row: RowDataPacket): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = serializeCell(value);
  }
  return out;
}

function serializeCell(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Buffer.isBuffer(value)) {
    return `0x${value.toString('hex')}`;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'object') {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return String(value);
    }
  }
  return value;
}
