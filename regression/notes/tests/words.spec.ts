import { expect, test } from '../support/fixtures.ts';

// Sources: services/example/README.md rule 10 and openapi.yaml streamWords. The framework reads the stream as it
// arrives, holds every `word` event to the contract (x-vgate-events) and fails a stream that ends without
// `data: [DONE]` (service.yaml rules.streaming).

const MISSING = '00000000-0000-4000-8000-000000000000';

test.describe('GET /notes/{noteId}/words', () => {
  test('[WRD-200] streams one word event per word of the title, then the body, then [DONE] (rule 10)', async ({
    api,
  }) => {
    const note = (
      await api.as('writer').post('/notes', { body: { title: 'Two words', body: 'and  more' } })
    ).expectSuccess(201);
    const res = await api.as('reader').stream('get', '/notes/{noteId}/words', { params: { noteId: note.id } });
    expect(res.status).toBe(200);
    expect(res.complete).toBe(true);
    expect(res.eventData).toEqual([
      { index: 0, word: 'Two' },
      { index: 1, word: 'words' },
      { index: 2, word: 'and' },
      { index: 3, word: 'more' },
    ]);
    expect(res.events.slice(0, 4).map((event) => [event.event, event.id])).toEqual([
      ['word', '0'],
      ['word', '1'],
      ['word', '2'],
      ['word', '3'],
    ]);
    expect(res.events.at(-1)?.data).toBe('[DONE]');
  });

  test('[WRD-401] refuses a call without a key, as JSON, before looking up the note (rule 10)', async ({ api }) => {
    const res = await api.anonymous().stream('get', '/notes/{noteId}/words', { params: { noteId: MISSING } });
    expect(res.expectError(401)).toMatchObject({ error: 'unauthorized' });
    expect(res.headers['www-authenticate']).toBe('ApiKey');
    expect(res.events).toEqual([]);
  });

  test('[WRD-404] answers not_found as JSON for an unknown note (rule 10)', async ({ api }) => {
    const res = await api.as('reader').stream('get', '/notes/{noteId}/words', { params: { noteId: MISSING } });
    expect(res.expectError(404)).toMatchObject({ error: 'not_found' });
  });
});
