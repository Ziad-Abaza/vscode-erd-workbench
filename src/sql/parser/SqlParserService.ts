import { Parser } from 'node-sql-parser';
import type { ClassifiedStatement, SqlRiskClass } from '../../../shared/types';

export interface ParseBatchResult {
  ok: boolean;
  statements: ClassifiedStatement[];
  reason?: string;
}

/**
 * MySQL/MariaDB-oriented parser + classifier.
 * Fail-closed: unparseable input never yields an allowed decision upstream.
 */
export class SqlParserService {
  private readonly parser = new Parser();

  splitAndClassify(sql: string): ParseBatchResult {
    const trimmed = sql.trim();
    if (!trimmed) {
      return { ok: false, statements: [], reason: 'Empty SQL' };
    }

    let ast: unknown;
    try {
      ast = this.parser.astify(trimmed, { database: 'MySQL' });
    } catch (err) {
      return {
        ok: false,
        statements: [],
        reason: `SQL parse failed (fail-closed): ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const nodes = Array.isArray(ast) ? ast : [ast];
    if (nodes.length === 0) {
      return { ok: false, statements: [], reason: 'No statements parsed (fail-closed)' };
    }

    const statements: ClassifiedStatement[] = [];
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i] as Record<string, unknown>;
      try {
        const sqlText = this.safeSqlify(node) ?? extractStatementSlice(trimmed, i, nodes.length);
        statements.push(this.classifyNode(node, sqlText, i));
      } catch (err) {
        return {
          ok: false,
          statements: [],
          reason: `Statement ${i + 1} classification failed (fail-closed): ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }
    }

    if (statements.some((s) => s.risk === 'unknown')) {
      return {
        ok: false,
        statements,
        reason: 'One or more statements could not be reliably classified (fail-closed)',
      };
    }

    return { ok: true, statements };
  }

  private safeSqlify(node: unknown): string | undefined {
    try {
      // node-sql-parser AST typing is incomplete across dialects
      return this.parser.sqlify(node as never, { database: 'MySQL' });
    } catch {
      return undefined;
    }
  }

  private classifyNode(node: Record<string, unknown>, sql: string, index: number): ClassifiedStatement {
    const type = String(node.type ?? '').toLowerCase();
    const affected = collectAffectedObjects(node);
    const notes: string[] = [];

    if (!type) {
      return {
        index,
        sql,
        risk: 'unknown',
        statementType: 'unknown',
        affectedObjects: affected,
        notes: ['Missing AST type'],
      };
    }

    // Dynamic SQL — undecidable
    if (type === 'prepare' || type === 'execute' || type === 'deallocate') {
      return {
        index,
        sql,
        risk: 'unknown',
        statementType: type,
        affectedObjects: affected,
        notes: ['Dynamic SQL cannot be statically classified'],
      };
    }

    if (['select', 'show', 'desc', 'describe', 'explain', 'set'].includes(type)) {
      // SET can change session state — treat as write if not read-only session vars we know
      if (type === 'set') {
        return {
          index,
          sql,
          risk: 'write',
          statementType: type,
          affectedObjects: affected,
          notes: ['SET classified as write'],
        };
      }
      return { index, sql, risk: 'read', statementType: type, affectedObjects: affected };
    }

    if (type === 'use') {
      return { index, sql, risk: 'read', statementType: type, affectedObjects: affected };
    }

    if (type === 'call') {
      notes.push('CALL routine body not fully analyzable');
      return { index, sql, risk: 'unknown', statementType: type, affectedObjects: affected, notes };
    }

    if (['insert', 'replace', 'update', 'load'].includes(type)) {
      const risk: SqlRiskClass =
        type === 'replace' || (type === 'update' && !hasWhere(node)) ? 'destructive' : 'write';
      if (type === 'update' && !hasWhere(node)) {
        notes.push('UPDATE without WHERE classified as destructive');
      }
      return { index, sql, risk, statementType: type, affectedObjects: affected, notes };
    }

    if (type === 'delete') {
      return {
        index,
        sql,
        risk: 'destructive',
        statementType: type,
        affectedObjects: affected,
        notes: hasWhere(node) ? ['DELETE always requires confirmation'] : ['DELETE without WHERE'],
      };
    }

    if (type === 'truncate') {
      return {
        index,
        sql,
        risk: 'destructive',
        statementType: type,
        affectedObjects: affected,
      };
    }

    if (type === 'drop') {
      return {
        index,
        sql,
        risk: 'destructive',
        statementType: type,
        affectedObjects: affected,
      };
    }

    if (type === 'alter') {
      const risk = isDestructiveAlter(node) ? 'destructive' : 'write';
      if (risk === 'destructive') {
        notes.push('ALTER contains DROP of column/index/constraint/table');
      }
      return { index, sql, risk, statementType: type, affectedObjects: affected, notes };
    }

    if (
      [
        'create',
        'create-table',
        'create-index',
        'create-db',
        'create-view',
        'create-schema',
        'rename',
      ].includes(type) ||
      type.startsWith('create')
    ) {
      // Creating/replacing routines: write; body not fully analyzed
      if (/procedure|function|trigger|event/i.test(JSON.stringify(node).slice(0, 2000))) {
        notes.push('Routine DDL; body not fully analyzed');
      }
      return { index, sql, risk: 'write', statementType: type, affectedObjects: affected, notes };
    }

    // With / CTE wrappers — inspect inner
    if (type === 'with' || node.with) {
      const innerRisk = classifyWithInner(node);
      return {
        index,
        sql,
        risk: innerRisk,
        statementType: type,
        affectedObjects: affected,
        notes: ['Classified via CTE/WITH inner statement'],
      };
    }

    return {
      index,
      sql,
      risk: 'unknown',
      statementType: type,
      affectedObjects: affected,
      notes: [`Unrecognized statement type: ${type}`],
    };
  }
}

function extractStatementSlice(sql: string, index: number, total: number): string {
  if (total === 1) {
    return sql;
  }
  return `-- statement ${index + 1}\n${sql}`;
}

function hasWhere(node: Record<string, unknown>): boolean {
  if (node.where) {
    return true;
  }
  // CTE / nested
  const raw = JSON.stringify(node);
  // Prefer structural checks
  if (Array.isArray(node.table) || node.from) {
    /* continue */
  }
  if (node.delete && typeof node.delete === 'object') {
    return Boolean((node as { where?: unknown }).where);
  }
  // WITH ... DELETE
  if (node.type === 'delete') {
    return Boolean(node.where);
  }
  // Some ASTs nest under stmt
  if (node.stmt && typeof node.stmt === 'object') {
    return hasWhere(node.stmt as Record<string, unknown>);
  }
  void raw;
  return Boolean(node.where);
}

function isDestructiveAlter(node: Record<string, unknown>): boolean {
  const expr = node.expr ?? node.definitions ?? node.table_options;
  const text = JSON.stringify(expr ?? node).toLowerCase();
  return (
    /"resource"\s*:\s*"column"/.test(text) && /drop/.test(text) ||
    /drop\s*(column|index|key|primary|foreign|constraint|check)/.test(text) ||
    /"action"\s*:\s*"drop"/.test(text) ||
    /\bdrop\b/.test(text)
  );
}

function classifyWithInner(node: Record<string, unknown>): SqlRiskClass {
  const blob = JSON.stringify(node).toLowerCase();
  if (/\b"type"\s*:\s*"delete"/.test(blob) || /\bdelete\b/.test(blob) && /"type":"delete"/.test(blob)) {
    return 'destructive';
  }
  if (/"type"\s*:\s*"drop"/.test(blob) || /"type"\s*:\s*"truncate"/.test(blob)) {
    return 'destructive';
  }
  if (/"type"\s*:\s*"update"/.test(blob) && !/"where"/.test(blob)) {
    return 'destructive';
  }
  if (/"type"\s*:\s*"insert"/.test(blob) || /"type"\s*:\s*"update"/.test(blob) || /"type"\s*:\s*"replace"/.test(blob)) {
    return 'write';
  }
  if (/"type"\s*:\s*"select"/.test(blob)) {
    return 'read';
  }
  return 'unknown';
}

function collectAffectedObjects(node: Record<string, unknown>): string[] {
  const names = new Set<string>();
  const walk = (v: unknown): void => {
    if (!v || typeof v !== 'object') {
      return;
    }
    if (Array.isArray(v)) {
      v.forEach(walk);
      return;
    }
    const obj = v as Record<string, unknown>;
    if (typeof obj.table === 'string') {
      const schema = typeof obj.db === 'string' || typeof obj.schema === 'string'
        ? String(obj.db ?? obj.schema)
        : undefined;
      names.add(schema ? `${schema}.${obj.table}` : obj.table);
    }
    if (obj.table && typeof obj.table === 'object') {
      walk(obj.table);
    }
    for (const val of Object.values(obj)) {
      if (val && typeof val === 'object') {
        walk(val);
      }
    }
  };
  walk(node);
  return [...names];
}
