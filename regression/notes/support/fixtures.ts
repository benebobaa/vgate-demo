import { createTest, expect } from '@vgate/framework/fixtures.ts';
import type { components, paths } from '../generated/openapi.ts';

export type Note = components['schemas']['Note'];
export type NoteInput = components['schemas']['NoteInput'];

/** The framework's test, typed by the example's contract. The example needs no fixtures of its own. */
export const test = createTest<paths>();

/**
 * A run-unique tag (`^[a-z0-9-]{1,20}$`, README rule 6): notes created with it are this test's own, so list
 * assertions hold while other tests write in parallel.
 */
export function uniqueTag(unique: (prefix: string) => string): string {
  return unique('t')
    .replace(/[^a-z0-9-]/g, '-')
    .slice(-20);
}

export { expect };
