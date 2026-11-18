import type { Caller } from '@vgate/framework/http/client.ts';
import type { paths } from '../generated/openapi.ts';
import { expect, test, uniqueTag, type Note, type NoteInput } from '../support/fixtures.ts';

// Sources: services/example/README.md (rules 1-8) and openapi.yaml. Every response is also held to the contract,
// the header rules and the UTC datetime rule by the framework's client.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MISSING = '00000000-0000-4000-8000-000000000000';

async function create(caller: Caller<paths>, input: NoteInput): Promise<Note> {
  return (await caller.post('/notes', { body: input })).expectSuccess(201);
}

test.describe('GET /health', () => {
  test('[HLT-200] answers UP without a key', async ({ api }) => {
    const res = await api.anonymous().get('/health');
    expect(res.expectSuccess()).toEqual({ status: 'UP' });
  });
});

test.describe('POST /notes', () => {
  test('[CRT-201] creates a note with a fresh id and equal timestamps (rule 5)', async ({ api, unique }) => {
    const tag = uniqueTag(unique);
    const note = await create(api.as('writer'), { title: 'Groceries', body: 'milk', tags: [tag] });
    expect(note.id).toMatch(UUID);
    expect(note).toMatchObject({ title: 'Groceries', body: 'milk', tags: [tag] });
    expect(note.updatedAt).toBe(note.createdAt);
    const read = (await api.as('reader').get('/notes/{noteId}', { params: { noteId: note.id } })).expectSuccess();
    expect(read).toEqual(note);
  });

  test('[CRT-201-DEFAULTS] stores an omitted body as null and omitted tags as [] (rule 5)', async ({ api }) => {
    const note = await create(api.as('writer'), { title: 'Only a title' });
    expect(note.body).toBeNull();
    expect(note.tags).toEqual([]);
  });

  const invalid: Array<[string, Record<string, unknown> | undefined, string | undefined]> = [
    ['title missing', {}, undefined],
    ['title empty', { title: '' }, undefined],
    ['title of 81 characters', { title: 'x'.repeat(81) }, undefined],
    ['an unknown field', { title: 't', color: 'red' }, undefined],
    ['a tag outside ^[a-z0-9-]{1,20}$', { title: 't', tags: ['Upper'] }, undefined],
    ['six tags', { title: 't', tags: ['a', 'b', 'c', 'd', 'e', 'f'] }, undefined],
    ['a repeated tag', { title: 't', tags: ['a', 'a'] }, undefined],
    ['a body that is not JSON', undefined, '{"title":'],
  ];
  for (const [what, body, raw] of invalid) {
    test(`[CRT-400] refuses ${what} (rule 3)`, async ({ api }) => {
      const res = await api.as('writer').post('/notes', raw === undefined ? { invalidBody: body } : { rawBody: raw });
      expect(res.expectError(400)).toMatchObject({ error: 'bad_request' });
    });
  }

  test('[CRT-400-CONTENT-TYPE] refuses a JSON body not sent as application/json (rule 3)', async ({ api }) => {
    const res = await api
      .as('writer')
      .post('/notes', { rawBody: '{"title":"t"}', headers: { 'Content-Type': 'text/plain' } });
    expect(res.expectError(400)).toMatchObject({ error: 'bad_request' });
  });

  test('[CRT-401] refuses a call without a key or with an unknown one (rule 1)', async ({ api }) => {
    for (const caller of [api.anonymous(), api.asToken('not-a-key')]) {
      const res = await caller.post('/notes', { body: { title: 't' } });
      expect(res.expectError(401)).toMatchObject({ error: 'unauthorized' });
    }
  });

  test('[CRT-403] refuses a reader and creates nothing (rule 2)', async ({ api, unique }) => {
    const tag = uniqueTag(unique);
    const res = await api.as('reader').post('/notes', { body: { title: 't', tags: [tag] } });
    expect(res.expectError(403)).toMatchObject({ error: 'forbidden' });
    const page = (await api.as('reader').get('/notes', { query: { tag: [tag] } })).expectSuccess();
    expect(page.total).toBe(0);
  });

  test('[CRT-403-BEFORE-400] checks the key before the body (rule 2)', async ({ api }) => {
    const res = await api.as('reader').post('/notes', { invalidBody: {} });
    expect(res.expectError(403)).toMatchObject({ error: 'forbidden' });
  });
});

test.describe('GET /notes', () => {
  test('[LST-200] lists the matching notes newest first, with their total (rule 6)', async ({ api, unique }) => {
    const tag = uniqueTag(unique);
    const writer = api.as('writer');
    const first = await create(writer, { title: 'first', tags: [tag] });
    const second = await create(writer, { title: 'second', tags: [tag] });
    const page = (await api.as('reader').get('/notes', { query: { tag: [tag] } })).expectSuccess();
    expect(page).toEqual({ items: [second, first], total: 2 });
  });

  test('[LST-200-LIMIT] returns at most limit notes; total counts them all (rule 6)', async ({ api, unique }) => {
    const tag = uniqueTag(unique);
    for (const title of ['a', 'b', 'c']) await create(api.as('writer'), { title, tags: [tag] });
    const page = (await api.as('reader').get('/notes', { query: { tag: [tag], limit: 2 } })).expectSuccess();
    expect(page.items.map((n) => n.title)).toEqual(['c', 'b']);
    expect(page.total).toBe(3);
  });

  test('[LST-200-TAGS] with several tags, only notes carrying every one (rule 6)', async ({ api, unique }) => {
    const [a, b] = [uniqueTag(unique), uniqueTag(unique)];
    const both = await create(api.as('writer'), { title: 'both', tags: [a, b] });
    await create(api.as('writer'), { title: 'only a', tags: [a] });
    const page = (await api.as('reader').get('/notes', { query: { tag: [a, b] } })).expectSuccess();
    expect(page).toEqual({ items: [both], total: 1 });
  });

  for (const limit of ['0', '101', 'ten']) {
    test(`[LST-400-LIMIT] refuses limit=${limit} (contract: integer 1-100; rule 3)`, async ({ api }) => {
      const res = await api.as('reader').get('/notes', { invalidQuery: { limit } });
      expect(res.expectError(400)).toMatchObject({ error: 'bad_request' });
    });
  }

  test('[LST-400-TAG] refuses a tag outside ^[a-z0-9-]{1,20}$ (rule 3)', async ({ api }) => {
    const res = await api.as('reader').get('/notes', { invalidQuery: { tag: 'Not_A_Tag' } });
    expect(res.expectError(400)).toMatchObject({ error: 'bad_request' });
  });

  test('[LST-401] refuses a call without a key (rule 1)', async ({ api }) => {
    expect((await api.anonymous().get('/notes')).expectError(401)).toMatchObject({ error: 'unauthorized' });
  });
});

test.describe('GET /notes/{noteId}', () => {
  test('[GET-200] answers the note', async ({ api }) => {
    const note = await create(api.as('writer'), { title: 'read me' });
    const res = await api.as('reader').get('/notes/{noteId}', { params: { noteId: note.id } });
    expect(res.expectSuccess()).toEqual(note);
  });

  test('[GET-401] refuses a call without a key, before looking the note up (rule 1)', async ({ api }) => {
    const res = await api.anonymous().get('/notes/{noteId}', { params: { noteId: MISSING } });
    expect(res.expectError(401)).toMatchObject({ error: 'unauthorized' });
  });

  test('[GET-404] answers not_found for an unknown id', async ({ api }) => {
    const res = await api.as('reader').get('/notes/{noteId}', { params: { noteId: MISSING } });
    expect(res.expectError(404)).toMatchObject({ error: 'not_found' });
  });
});

test.describe('PUT /notes/{noteId}', () => {
  test('[PUT-200] replaces title, body and tags, keeps createdAt, moves updatedAt (rule 5)', async ({
    api,
    unique,
  }) => {
    const tag = uniqueTag(unique);
    const note = await create(api.as('writer'), { title: 'old', body: 'old body', tags: ['x'] });
    const res = await api
      .as('writer')
      .put('/notes/{noteId}', { params: { noteId: note.id }, body: { title: 'new', tags: [tag] } });
    const replaced = res.expectSuccess();
    expect(replaced).toMatchObject({ id: note.id, title: 'new', body: null, tags: [tag], createdAt: note.createdAt });
    expect(Date.parse(replaced.updatedAt)).toBeGreaterThan(Date.parse(note.updatedAt));
  });

  test('[PUT-400] refuses an invalid body and changes nothing (rule 3)', async ({ api }) => {
    const note = await create(api.as('writer'), { title: 'keep' });
    const res = await api
      .as('writer')
      .put('/notes/{noteId}', { params: { noteId: note.id }, invalidBody: { title: '' } });
    expect(res.expectError(400)).toMatchObject({ error: 'bad_request' });
    const read = (await api.as('reader').get('/notes/{noteId}', { params: { noteId: note.id } })).expectSuccess();
    expect(read).toEqual(note);
  });

  test('[PUT-400-BEFORE-404] validates the body before looking the note up (rule 4)', async ({ api }) => {
    const res = await api.as('writer').put('/notes/{noteId}', { params: { noteId: MISSING }, invalidBody: {} });
    expect(res.expectError(400)).toMatchObject({ error: 'bad_request' });
  });

  test('[PUT-401] refuses a call without a key (rule 1)', async ({ api }) => {
    const res = await api.anonymous().put('/notes/{noteId}', { params: { noteId: MISSING }, body: { title: 't' } });
    expect(res.expectError(401)).toMatchObject({ error: 'unauthorized' });
  });

  test('[PUT-403] refuses a reader and changes nothing (rule 2)', async ({ api }) => {
    const note = await create(api.as('writer'), { title: 'keep' });
    const res = await api.as('reader').put('/notes/{noteId}', { params: { noteId: note.id }, body: { title: 'x' } });
    expect(res.expectError(403)).toMatchObject({ error: 'forbidden' });
    const read = (await api.as('reader').get('/notes/{noteId}', { params: { noteId: note.id } })).expectSuccess();
    expect(read).toEqual(note);
  });

  test('[PUT-404] answers not_found for an unknown id with a valid body', async ({ api }) => {
    const res = await api.as('writer').put('/notes/{noteId}', { params: { noteId: MISSING }, body: { title: 't' } });
    expect(res.expectError(404)).toMatchObject({ error: 'not_found' });
  });
});

test.describe('DELETE /notes/{noteId}', () => {
  test('[DEL-204] deletes the note; it is gone afterwards', async ({ api }) => {
    const note = await create(api.as('writer'), { title: 'bye' });
    const res = await api.as('writer').delete('/notes/{noteId}', { params: { noteId: note.id } });
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    const gone = await api.as('reader').get('/notes/{noteId}', { params: { noteId: note.id } });
    gone.expectError(404);
  });

  test('[DEL-401] refuses a call without a key (rule 1)', async ({ api }) => {
    const res = await api.anonymous().delete('/notes/{noteId}', { params: { noteId: MISSING } });
    expect(res.expectError(401)).toMatchObject({ error: 'unauthorized' });
  });

  test('[DEL-403] refuses a reader; the note stays (rule 2)', async ({ api }) => {
    const note = await create(api.as('writer'), { title: 'stay' });
    const res = await api.as('reader').delete('/notes/{noteId}', { params: { noteId: note.id } });
    expect(res.expectError(403)).toMatchObject({ error: 'forbidden' });
    (await api.as('reader').get('/notes/{noteId}', { params: { noteId: note.id } })).expectSuccess();
  });

  test('[DEL-404] answers not_found for an unknown id', async ({ api }) => {
    const res = await api.as('writer').delete('/notes/{noteId}', { params: { noteId: MISSING } });
    expect(res.expectError(404)).toMatchObject({ error: 'not_found' });
  });
});
