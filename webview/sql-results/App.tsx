import { useEffect, useMemo, useState } from 'react';
import type { QueryResult, SqlResultsHostMessage, SqlRunSnapshot } from '../../shared/types';
import { post } from './vscodeApi';

export function App(): JSX.Element {
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

  const statusLabel = useMemo(() => {
    if (!run) {
      return 'idle';
    }
    return run.status;
  }, [run]);

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
            disabled={!active || active.columns.length === 0}
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
              className={`tab ${i === activeIndex ? 'active' : ''}`}
              onClick={() => setActiveIndex(i)}
            >
              Result {i + 1}
              {r.columns.length ? ` (${r.rows.length})` : r.affectedRows !== undefined ? ` (${r.affectedRows})` : ''}
            </button>
          ))}
        </nav>
      ) : null}

      <main className="body">{
        {!run ? (
          <div className="message">No query run yet. Use Execute SQL on a .sql editor.</div>
        ) : run.status === 'error' ? (
          <div className="message error">{run.error ?? 'Query failed'}</div>
        ) : run.status === 'cancelled' ? (
          <div className="message">{run.error ?? 'Query cancelled'}</div>
        ) : run.status === 'running' && !active ? (
          <div className="message">{progress ?? 'Running…'}</div>
        ) : active && active.columns.length === 0 ? (
          <div className="affected">
            {active.affectedRows !== undefined
              ? `OK · ${active.affectedRows} row(s) affected`
              : 'OK · statement completed'}
            {active.durationMs !== undefined ? ` · ${formatMs(active.durationMs)}` : ''}
          </div>
        ) : active ? (
          <ResultGrid result={active} />
        ) : (
          <div className="message">No result set</div>
        )}
      </main>

      {active && active.columns.length > 0 ? (
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

function ResultGrid({ result }: { result: QueryResult }): JSX.Element {
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
