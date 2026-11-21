/** Thrown when a running SQL statement is aborted by the user or host. */
export class QueryCancelledError extends Error {
  readonly code = 'QUERY_CANCELLED' as const;

  constructor(message = 'Query cancelled') {
    super(message);
    this.name = 'QueryCancelledError';
  }
}

export function isQueryCancelledError(err: unknown): err is QueryCancelledError {
  return (
    err instanceof QueryCancelledError ||
    (err instanceof Error &&
      ((err as { code?: string }).code === 'QUERY_CANCELLED' || err.name === 'QueryCancelledError'))
  );
}
