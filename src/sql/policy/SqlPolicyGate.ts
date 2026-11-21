import * as vscode from 'vscode';
import type { PolicyDecision, SqlRiskClass } from '../../../shared/types';
import { SqlParserService } from '../parser/SqlParserService';

export type ExecutionSource = 'sql-runner' | 'mutation-pipeline' | 'mcp';

export interface GateRequest {
  sql: string;
  source: ExecutionSource;
  /** When source is mcp/mutation and approval already obtained for this exact SQL */
  approvalContentHash?: string;
  skipUiConfirm?: boolean;
}

/**
 * Sole security boundary for SQL execution decisions.
 * Webview and MCP cannot bypass this gate.
 */
export class SqlPolicyGate {
  constructor(private readonly parser: SqlParserService) {}

  evaluate(request: GateRequest): PolicyDecision {
    const parsed = this.parser.splitAndClassify(request.sql);
    if (!parsed.ok) {
      return {
        allowed: false,
        requiresConfirmation: false,
        risk: 'unknown',
        statements: parsed.statements,
        reason: parsed.reason ?? 'Fail-closed: unparseable or unclassified SQL',
        previewSql: request.sql,
      };
    }

    const risk = maxRisk(parsed.statements.map((s) => s.risk));
    const config = vscode.workspace.getConfiguration('erdWorkbench');
    const allowUnknownCall = config.get<boolean>('allowUnknownCall', false);
    const allowUnattended = config.get<boolean>('allowUnattendedWrites', false);
    const confirmWrite = config.get<boolean>('confirmWriteSql', true);

    // CALL handling: still unknown from parser — only allow if setting enabled and not MCP
    if (parsed.statements.some((s) => s.statementType === 'call')) {
      if (!allowUnknownCall || request.source === 'mcp') {
        return {
          allowed: false,
          requiresConfirmation: false,
          risk: 'unknown',
          statements: parsed.statements,
          reason: 'CALL statements denied by default (fail-closed). Enable erdWorkbench.allowUnknownCall for SQL runner only.',
          previewSql: request.sql,
        };
      }
    }

    if (risk === 'unknown') {
      return {
        allowed: false,
        requiresConfirmation: false,
        risk,
        statements: parsed.statements,
        reason: 'Fail-closed: unknown risk',
        previewSql: request.sql,
      };
    }

    if (risk === 'read') {
      return {
        allowed: true,
        requiresConfirmation: false,
        risk,
        statements: parsed.statements,
        previewSql: formatPreview(parsed.statements.map((s) => s.sql)),
      };
    }

    // Already host-approved (MCP or MutationPipeline) — still must have content hash
    if (request.approvalContentHash) {
      if (request.source !== 'mcp' && request.source !== 'mutation-pipeline') {
        return {
          allowed: false,
          requiresConfirmation: false,
          risk,
          statements: parsed.statements,
          reason: 'Approval tokens are only valid for MCP / MutationPipeline sources',
          previewSql: formatPreview(parsed.statements.map((s) => s.sql)),
        };
      }
      return {
        allowed: true,
        requiresConfirmation: false,
        risk,
        statements: parsed.statements,
        previewSql: formatPreview(parsed.statements.map((s) => s.sql)),
      };
    }

    // MCP never unattended without approval token
    if (request.source === 'mcp') {
      return {
        allowed: false,
        requiresConfirmation: true,
        risk,
        statements: parsed.statements,
        reason: 'MCP modifications require a host-issued approval token bound to this exact SQL',
        previewSql: formatPreview(parsed.statements.map((s) => s.sql)),
      };
    }

    if (risk === 'destructive') {
      return {
        allowed: true,
        requiresConfirmation: !request.skipUiConfirm,
        risk,
        statements: parsed.statements,
        previewSql: formatPreview(parsed.statements.map((s) => s.sql)),
      };
    }

    // write
    const needsConfirm =
      request.source === 'mutation-pipeline'
        ? true
        : confirmWrite && !allowUnattended;

    return {
      allowed: true,
      requiresConfirmation: needsConfirm && !request.skipUiConfirm,
      risk,
      statements: parsed.statements,
      previewSql: formatPreview(parsed.statements.map((s) => s.sql)),
    };
  }

  async authorizeOrConfirm(request: GateRequest): Promise<PolicyDecision> {
    const decision = this.evaluate(request);
    if (!decision.allowed) {
      return decision;
    }
    if (!decision.requiresConfirmation) {
      return decision;
    }

    const riskLabel = decision.risk.toUpperCase();
    const objects = [...new Set(decision.statements.flatMap((s) => s.affectedObjects))];
    const detail = [
      `Risk: ${riskLabel}`,
      `Statements: ${decision.statements.length}`,
      objects.length ? `Objects: ${objects.slice(0, 20).join(', ')}` : undefined,
      '',
      decision.previewSql.slice(0, 2000),
    ]
      .filter(Boolean)
      .join('\n');

    const pick = await vscode.window.showWarningMessage(
      `${riskLabel} SQL requires confirmation before execution.`,
      { modal: true, detail },
      'Confirm Execute',
      'Cancel'
    );

    if (pick !== 'Confirm Execute') {
      return {
        ...decision,
        allowed: false,
        reason: 'User cancelled confirmation',
      };
    }
    return { ...decision, requiresConfirmation: false };
  }
}

function maxRisk(risks: SqlRiskClass[]): SqlRiskClass {
  const order: SqlRiskClass[] = ['read', 'write', 'destructive', 'unknown'];
  return risks.reduce((a, b) => (order.indexOf(b) > order.indexOf(a) ? b : a), 'read' as SqlRiskClass);
}

function formatPreview(parts: string[]): string {
  return parts.join(';\n') + (parts.length ? ';' : '');
}
