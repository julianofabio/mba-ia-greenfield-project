import { QueryFailedError } from 'typeorm';
import { isPgUniqueViolationOnColumn } from './pg-errors';

function makeQueryError(code: string, detail: string): QueryFailedError {
  const err = new QueryFailedError('INSERT', [], new Error('db')) as any;
  err.code = code;
  err.detail = detail;
  return err;
}

describe('isPgUniqueViolationOnColumn', () => {
  it('should match a unique violation on the given column', () => {
    const err = makeQueryError(
      '23505',
      'Key (public_id)=(AAAAAAAAAAA) already exists.',
    );
    expect(isPgUniqueViolationOnColumn(err, 'public_id')).toBe(true);
  });

  it('should not match a unique violation on another column', () => {
    const err = makeQueryError('23505', 'Key (id)=(x) already exists.');
    expect(isPgUniqueViolationOnColumn(err, 'public_id')).toBe(false);
  });

  it('should not match other database errors', () => {
    const err = makeQueryError('23503', 'Key (channel_id)=(x) is not present.');
    expect(isPgUniqueViolationOnColumn(err, 'channel_id')).toBe(false);
  });

  it('should not match non-database errors', () => {
    expect(isPgUniqueViolationOnColumn(new Error('boom'), 'public_id')).toBe(
      false,
    );
  });
});
