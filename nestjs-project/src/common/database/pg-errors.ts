import { QueryFailedError } from 'typeorm';

const PG_UNIQUE_VIOLATION = '23505';

export function isPgUniqueViolationOnColumn(
  err: unknown,
  column: string,
): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  // TypeORM copies the pg driver fields (code, detail) onto the error itself.
  const { code, detail } = err as QueryFailedError & {
    code?: unknown;
    detail?: unknown;
  };
  return (
    code === PG_UNIQUE_VIOLATION &&
    typeof detail === 'string' &&
    detail.includes(`(${column})`)
  );
}
