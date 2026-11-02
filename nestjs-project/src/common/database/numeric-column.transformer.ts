import type { ValueTransformer } from 'typeorm';

/**
 * The `pg` driver returns `bigint` and `numeric` columns as strings to avoid
 * precision loss. Use this transformer only for columns whose values stay
 * within `Number.MAX_SAFE_INTEGER` (e.g. byte sizes up to 10 GiB, durations).
 */
export const numericColumnTransformer: ValueTransformer = {
  to: (value: number | null | undefined) => value,
  from: (value: string | null) => (value === null ? null : Number(value)),
};
