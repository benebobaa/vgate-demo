# Writing tests with the framework

The framework already checks, on **every** call: the status is documented for the operation, the body matches the
contract's schema (undocumented properties fail when `strictResponseProperties` is on), the header rules, the
datetime offsets, and each event of a stream. A test asserts behaviour: the code, the values that carry meaning, the
rows written, the events published, the downstream effect.

## Layout

```
<svc-dir>/
  support/fixtures.ts     test + expect, typed by the contract, extended with the service's fixtures
  support/personas.ts     users in each state, built through the API
  tests/<area>/*.spec.ts  one file per operation group
  tests/authz/            role matrix and gate states, table-driven
  tests/faults/           dependency failures; run alone by the `faults` project
```

`support/fixtures.ts` builds the test from the framework; tests import from it, with `@playwright/test` reached only
through the framework:

```ts
// support/fixtures.ts
import { createTest, expect } from '@vgate/framework/fixtures.ts';      // or createDepsTest from
import type { paths } from '../generated/openapi.ts';                    // '@vgate/framework/deps/fixtures.ts'
export const test = createTest<paths>();                                 // when the service has dependencies
export { expect };

// tests/<area>/*.spec.ts
import { expect, test } from '../../support/fixtures.ts';
```

## Calling the API

```ts
// A seeded user from service.yaml; path and body are typed from the contract.
const res = await api.as('writer').post('/notes', { body: { title, tags: ['draft'] } });

// Path and query parameters; every verb the contract documents is typed (get, post, put, patch, delete).
await api.as('reader').get('/notes', { query: { tag: ['a', 'b'], limit: 2 } });
await api.as('writer').put('/notes/{noteId}', { params: { noteId }, body: { title: 'new' } });

// A user created during the run (persona), a raw token, a session, or no credential at all
await api.asCredentials(persona).get('/me');
await api.asToken(expiredToken).get('/me');
await api.asSession(cookieValue, csrfToken).get('/me');
await api.anonymous().get('/me');

// Deliberately invalid input: invalidBody / invalidQuery are not type-checked, rawBody is sent verbatim
await api.as('writer').post('/notes', { invalidBody: { title: '' } });
await api.as('reader').get('/notes', { invalidQuery: { limit: 'ten' } });
await api.as('writer').post('/notes', { rawBody: '{"title":' });

// Outside the contract on purpose (an undocumented method or path): the untyped escape hatch
await api.as('writer').send('PATCH', '/notes', { validate: false });
```

How a seeded user authenticates comes from `service.yaml`, never from the test: a `token` is sent as the configured
header and scheme, a `password` logs in through the session login or Keycloak, a user with neither is anonymous.
Tests never build `Authorization` or `Cookie` headers themselves. A test that ends or revokes a session (logout,
password change, revoking other sessions) takes its own: `api.as('owner', { newSession: true })`, so it never logs
out the other tests of its worker.

`validate: false` turns the automatic checks off for one call. Use it only for a call that is outside the contract on
purpose and say why in a comment. Such calls do not count toward coverage and are never reported as responses outside
the contract.

Every validated call counts toward the observed coverage, setup calls included. Coverage says a response happened and
matched the contract; only the scenario's own assertions say it was right, so each scenario asserts its own outcome.

When a test needs a 403 from the permission check, send a valid body: validation usually runs first and answers 400.

## Asserting

```ts
const note = res.expectSuccess();               // asserts the success status (+ code with an envelope), returns the data
expect(note.tags).toEqual(['draft']);
const created = res.expectSuccess(201);

const error = res.expectError(409, 'idempotency_conflict');  // asserts status (+ code), returns the error body
expect(error.message).toContain('Idempotency-Key');
```

Assertion messages already include the method, path, status, X-Request-Id and the body, so a failure is traceable in
the backend's logs.

## Streams

```ts
const res = await api.as('reader').stream('get', '/notes/{noteId}/words', { params: { noteId } });
expect(res.complete).toBe(true);                       // ended with its terminal event, not cut off
expect(res.eventData).toEqual([{ index: 0, word: 'Two' }, { index: 1, word: 'words' }]);
expect(res.events.at(-1)?.data).toBe('[DONE]');
```

A stream that stops before its terminal event, or stalls longer than the event timeout, fails the call. An error
answered before the stream starts is a normal response: `res.expectError(401)`. Details: vgate docs `streaming.md`.

## Webhooks

```ts
const res = await api.webhook('payments', { type: 'payment.paid', id: invoiceId });          // signed as configured
await api.webhook('payments', payload, { timestamp: Math.floor(Date.now() / 1000) - 8 * 86400 }); // too old: refused
await api.webhook('payments', payload, { secret: 'wrong' });                                  // bad signature
await api.webhook('payments', payload, { unsigned: true });
```

Assert what the webhook changed (rows, a status read back through the API), that a refused delivery changed nothing,
and that a replayed delivery is idempotent when a source says so. Details: vgate docs `webhooks.md`.

## Dependencies

With `createDepsTest`, tests get `stubs.<name>`, `events`, `cache` and `faults` (vgate docs `dependencies.md`):

- A stub answers only what the provider's contract documents; the framework refuses any other, so a stub can never
  invent provider behaviour. Every stub matches on a value this test made unique, so parallel tests never share one.
- `stub.calls()` returns what the backend sent, validated against the provider's request schema: assert the request
  carries what the rule names.
- `events.expect(topic, predicate)` waits for a message and validates it against the topic's schema;
  `events.published(...)` lists them, so a rejected call can assert none was published.

## The database

Tests state their SQL so a reviewer sees which rows are expected.

```ts
const row = await db.one<{ status: string; amount: number }>(
  'select status, amount from orders where id = $1', [orderId]);
expect(row).toEqual({ status: 'paid', amount: 2 * unitPrice });

// A rejected write wrote nothing
expect(await db.count('select count(*) from orders where reference = $1', [reference])).toBe(0);
```

Audit or history rows: assert the actor, the kind of change, the object, and the values that matter. Find your row by the object
id, not by "the latest row": other workers write concurrently.

## Keycloak

```ts
const account = await kc.createUser({ username: unique('cust'), password }); // deleted when the worker ends
const token = await kc.passwordToken(account.username, password);
```

`claimsOf(token)` (from `@vgate/framework/auth/keycloak.ts`) reads a token's claims, e.g. its `sub`.

## Personas

Users in a given state, built through the API exactly as a real user would get there, never by inserting rows. That
keeps tests honest: a persona that cannot be built is a finding. A persona returns at least
`{ username, password, userId }` and can be passed to `api.asCredentials(...)`.

## Data and parallel safety

Tests run in parallel and, later, against environments that are never reset.

- Create your own data with `unique('prefix')`, a run-unique lower-case name; depend only on data your test made.
- Leave the seeded users as they are (role, status, password): every other test relies on them.
- Assert your own records: filter list calls down to your data, or check that your record is in the page with the
  right values. Global counts and whole lists belong to every test at once.
- Wait on a condition when something is asynchronous (`expect.poll`, `events.expect`), never on a fixed sleep.
- Pause or stop dependencies only in `tests/faults/`.

## Structure and naming

- `test.describe('<operation>', ...)` per operation; each test title starts with its scenario id: `[CRT-201] ...`.
- One behaviour per test. Several inputs of one rule are one table-driven test:

```ts
for (const title of ['', 'x'.repeat(81)]) {
  test(`[CRT-400-TITLE] rejects title "${title.slice(0, 12)}"`, async ({ api }) => {
    const res = await api.as('writer').post('/notes', { invalidBody: { title } });
    res.expectError(400);
  });
}
```

- Every test runs and states its expectation: lint fails the gate on `test.only`, `test.skip` without a condition,
  `test.fixme` and `test.fail`. A known mismatch stays failing until a human registers it in `known-failures.yaml`;
  the framework then expects the failure by its scenario id, so the test itself never changes.

## Dependency faults

Only in `tests/faults/`, only when the environment is disposable. Fetch every token you need **before** pausing an
identity provider.

```ts
test.skip(({ svc }) => !svc.env.disposable, 'needs a disposable environment');
await faults.latency('payments', 5_000);          // restored when the test ends
const res = await api.as('clerk').post('/orders', { body: input });
res.expectError(504);
```

(`test.skip` with a condition is allowed there: it is environment selection, not a skipped test.)
