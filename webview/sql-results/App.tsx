import { useEffect, useMemo, useState, type ReactElement } from 'react';
import type { QueryResult, SqlResultsHostMessage, SqlRunSnapshot } from '../../shared/types';
import { post } from './vscodeApi';

export function App(): ReactElement {
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');
  const [run, setRun] = useState<SqlRunSnapshot | undefined>();
  const [progress, setProgress] = useState<string | undefined>();
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    const handler = (event: MessageEvent<SqlResultsHostMessage>) => {
      const msg = event.data;
      if (!msg || typeof msg !== 'object' || !('type' in msg)) {
        return;
      }
      switch (msg.type) {
        case 'init':
          setTheme(msg.theme);
          setRun(msg.run);
          setProgress(undefined);
          setActiveIndex(0);
          break;
        case 'theme':
          setTheme(msg.theme);
          break;
        case 'runStarted':
          setRun(msg.run);
          setProgress('Running…');
          setActiveIndex(0);
          break;
        case 'runProgress':
          setProgress(msg.message);
          break;
        case 'runCompleted':
        case 'runError':
        case 'runCancelled':
          setRun(msg.run);
          setProgress(undefined);
          setActiveIndex(0);
          break;
        default:
          break;
      }
    };
    window.addEventListener('message', handler);
    post({ type: 'ready' });
    return () => window.removeEventListener('message', handler);
  }, []);

  const results = run?.results ?? [];
  const active: QueryResult | undefined = results[activeIndex];
  const statusLabel = useMemo(() => (run ? run.status : 'idle'), [run]);
  const canCopy = Boolean(active && active.columns.length > 0);

  return (
    <div className="app">
      <header className="toolbar">
        <div className="meta">
          <span className={`status ${statusLabel}`}>{statusLabel}</span>
          {run ? (
            <>
              <span>{run.connectionName}</span>
              <span className="sql-preview" title={run.sqlPreview}>
                {run.sqlPreview}
              </span>
              {run.totalDurationMs !== undefined ? <span>{formatMs(run.totalDurationMs)}</span> : null}
              {progress ? <span>{progress}</span> : null}
            </>
          ) : (
            <span>Execute SQL to see results here</span>
          )}
        </div>
        <div className="actions">
          <button
            type="button"
            className="danger"
            disabled={run?.status !== 'running'}
            onClick={() => {
              if (run) {
                post({ type: 'cancelRun', runId: run.runId });
              }
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            disabled={!canCopy}
            onClick={() => post({ type: 'copyTsv', resultIndex: activeIndex })}
          >
            Copy TSV
          </button>
        </div>
      </header>

      {results.length > 1 ? (
        <nav className="tabs">
          {results.map((r, i) => (
            <button
              key={`${i}-${r.statementSql ?? ''}`}
              type="button"
              className={i === activeIndex ? 'tab active' : 'tab'}
              onClick={() => setActiveIndex(i)}
            >
              {tabLabel(r, i)}
            </button>
          ))}
        </nav>
      ) : null}

      <main className="body">{renderBody(run, active, progress)}</main>

      {canCopy && active ? (
        <footer className="footer">
          <span>
            {active.rows.length} row{active.rows.length === 1 ? '' : 's'}
            {active.truncated ? ' (truncated)' : ''}
            {active.durationMs !== undefined ? ` · ${formatMs(active.durationMs)}` : ''}
            {` · risk: ${active.risk}`}
          </span>
          <span>{active.columns.length} columns</span>
        </footer>
      ) : null}
    </div>
  );
}

function tabLabel(result: QueryResult, index: number): string {
  if (result.columns.length) {
    return `Result ${index + 1} (${result.rows.length})`;
  }
  if (result.affectedRows !== undefined) {
    return `Result ${index + 1} (${result.affectedRows})`;
  }
  return `Result ${index + 1}`;
}

function renderBody(
  run: SqlRunSnapshot | undefined,
  active: QueryResult | undefined,
  progress: string | undefined
): ReactElement {
  if (!run) {
    return <div className="message">No query run yet. Use Execute SQL on a .sql editor.</div>;
  }
  if (run.status === 'error') {
    return <div className="message error">{run.error ?? 'Query failed'}</div>;
  }
  if (run.status === 'cancelled') {
    return <div className="message">{run.error ?? 'Query cancelled'}</div>;
  }
  if (run.status === 'running' && !active) {
    return <div className="message">{progress ?? 'Running…'}</div>;
  }
  if (active && active.columns.length === 0) {
    const summary =
      active.affectedRows !== undefined
        ? `OK · ${active.affectedRows} row(s) affected`
        : 'OK · statement completed';
    const timing = active.durationMs !== undefined ? ` · ${formatMs(active.durationMs)}` : '';
    return (
      <div className="affected">
        {summary}
        {timing}
      </div>
    );
  }
  if (active) {
    return <ResultGrid result={active} />;
  }
  return <div className="message">No result set</div>;
}

function ResultGrid({ result }: { result: QueryResult }): ReactElement {
  return (
    <div className="grid-wrap">
      <table className="results">
        <thead>
          <tr>
            <th className="row-num">#</th>
            {result.columns.map((col) => (
              <th key={col} title={col}>
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              <td className="row-num">{rowIndex + 1}</td>
              {result.columns.map((col) => {
                const value = row[col];
                if (value === null || value === undefined) {
                  return (
                    <td key={col} className="null" title="NULL">
                      NULL
                    </td>
                  );
                }
                const text = formatDisplay(value);
                return (
                  <td key={col} title={text}>
                    {text}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatDisplay(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatMs(ms: number): string {
  if (ms < 1000) {
    return `${ms} ms`;
  }
  return `${(ms / 1000).toFixed(2)} s`;
}
