import type { ApiClient } from '@vgate/framework/http/client.ts';
import type { paths } from '../generated/openapi.ts';
import { expect, test, type Note } from '../support/fixtures.ts';

// Sources: regression/notes/README.md rule 11 and openapi.yaml receiveNoteWebhook. Deliveries are signed by the
// framework the way service.yaml `webhooks.notes` says the provider signs them.

const MISSING = '00000000-0000-4000-8000-000000000000';
const nowSeconds = () => Math.floor(Date.now() / 1000);

async function freshNote(api: ApiClient<paths>): Promise<Note> {
  return (await api.as('writer').post('/notes', { body: { title: 'Webhook target' } })).expectSuccess(201);
}

async function read(api: ApiClient<paths>, id: string): Promise<Note> {
  return (await api.as('reader').get('/notes/{noteId}', { params: { noteId: id } })).expectSuccess();
}

test.describe('POST /webhooks/notes', () => {
  test('[WHK-204] accepts a signed note.flagged delivery and flags the note (rule 11)', async ({ api }) => {
    const note = await freshNote(api);
    expect(note.flagged).toBeUndefined();
    const res = await api.webhook('notes', { type: 'note.flagged', noteId: note.id });
    expect(res.status).toBe(204);
    expect((await read(api, note.id)).flagged).toBe(true);
  });

  const refused: Array<[string, string, Parameters<ApiClient['webhook']>[2]]> = [
    ['WHK-403-OLD', 'signed more than 300 seconds ago', { timestamp: nowSeconds() - 301 }],
    ['WHK-403-FORGED', 'signed with another secret', { secret: 'whsec-forged' }],
    ['WHK-403-UNSIGNED', 'without a signature', { unsigned: true }],
  ];
  for (const [id, what, options] of refused) {
    test(`[${id}] refuses a delivery ${what} and changes nothing (rule 11)`, async ({ api }) => {
      const note = await freshNote(api);
      const res = await api.webhook('notes', { type: 'note.flagged', noteId: note.id }, options);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: 'forbidden' });
      expect((await read(api, note.id)).flagged).toBeUndefined();
    });
  }

  test('[WHK-403-TAMPERED] refuses a body changed after signing (rule 11)', async ({ api }) => {
    const note = await freshNote(api);
    const other = await freshNote(api);
    const res = await api.webhook(
      'notes',
      { type: 'note.flagged', noteId: note.id },
      { bodyAfterSigning: JSON.stringify({ type: 'note.flagged', noteId: other.id }) },
    );
    expect(res.status).toBe(403);
    expect((await read(api, other.id)).flagged).toBeUndefined();
  });

  test('[WHK-400] refuses a signed delivery of another event type (rule 11)', async ({ api }) => {
    const note = await freshNote(api);
    const res = await api.webhook('notes', { type: 'note.deleted', noteId: note.id });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'bad_request' });
    expect((await read(api, note.id)).flagged).toBeUndefined();
  });

  test('[WHK-404] answers not_found for a signed delivery about an unknown note (rule 11)', async ({ api }) => {
    const res = await api.webhook('notes', { type: 'note.flagged', noteId: MISSING });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'not_found' });
  });
});
