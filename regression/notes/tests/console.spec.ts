import { expect, test } from '../support/fixtures.ts';

// Sources: services/example/README.md rule 9 and openapi.yaml (login, logout, me). The framework logs `alice` in
// through service.yaml `auth.session` and sends the cookie and the CSRF token itself; these tests also check the
// login answer as such.

const COOKIE = /(?:^|\n)example_session=([^;]+)/;

test.describe('POST /session', () => {
  test('[SES-200] logs an account in: sets the session cookie and returns a CSRF token (rule 9)', async ({
    api,
    svc,
  }) => {
    const res = await api
      .anonymous()
      .post('/session', { body: { username: 'alice', password: svc.env.users.alice.password ?? '' } });
    const session = res.expectSuccess();
    expect(session.username).toBe('alice');
    expect(session.csrfToken).not.toBe('');
    expect(res.headers['set-cookie']).toMatch(COOKIE);
    expect(res.headers['set-cookie']).toMatch(/HttpOnly/);
  });

  test('[SES-400] refuses a body that is not exactly username and password (rule 9)', async ({ api }) => {
    const anon = api.anonymous();
    expect((await anon.post('/session', { invalidBody: { username: 'alice' } })).expectError(400)).toMatchObject({
      error: 'bad_request',
    });
    const extra = { username: 'alice', password: 'x', remember: true };
    expect((await anon.post('/session', { invalidBody: extra })).status).toBe(400);
  });

  test('[SES-401] refuses a wrong password and sets no cookie (rule 9)', async ({ api }) => {
    const res = await api.anonymous().post('/session', { body: { username: 'alice', password: 'wrong' } });
    expect(res.expectError(401)).toMatchObject({ error: 'unauthorized' });
    expect(res.headers['www-authenticate']).toBe('Session');
    expect(res.headers['set-cookie']).toBeUndefined();
  });
});

test.describe('GET /me', () => {
  test('[ME-200] answers the account of the session (rule 9)', async ({ api }) => {
    expect((await api.as('alice').get('/me')).expectSuccess()).toEqual({ username: 'alice' });
  });

  test('[ME-401] refuses a call without a session, an API key included (rule 9)', async ({ api }) => {
    for (const caller of [api.anonymous(), api.as('reader')]) {
      const res = await caller.get('/me');
      expect(res.expectError(401)).toMatchObject({ error: 'unauthorized' });
      expect(res.headers['www-authenticate']).toBe('Session');
    }
  });
});

test.describe('DELETE /session', () => {
  test('[OUT-204] logs out: the session no longer works afterwards (rule 9)', async ({ api }) => {
    // Its own session: logging out must not end the one the other tests share.
    const alice = api.as('alice', { newSession: true });
    expect((await alice.get('/me')).status).toBe(200);
    expect((await alice.delete('/session')).status).toBe(204);
    expect((await alice.get('/me')).expectError(401)).toMatchObject({ error: 'unauthorized' });
  });

  test('[OUT-401] refuses a call without a session (rule 9)', async ({ api }) => {
    const res = await api.anonymous().delete('/session', { headers: { 'X-CSRF-Token': 'anything' } });
    expect(res.expectError(401)).toMatchObject({ error: 'unauthorized' });
  });

  test('[OUT-403] refuses a logout without the CSRF token; the session keeps working (rule 9)', async ({
    api,
    svc,
  }) => {
    const login = await api
      .anonymous()
      .post('/session', { body: { username: 'alice', password: svc.env.users.alice.password ?? '' } });
    const cookie = COOKIE.exec(login.headers['set-cookie'] ?? '')?.[1] ?? '';
    const withoutToken = api.asSession(cookie);
    expect((await withoutToken.delete('/session')).expectError(403)).toMatchObject({ error: 'forbidden' });
    const wrongToken = api.asSession(cookie, 'not-the-token');
    expect((await wrongToken.delete('/session')).status).toBe(403);
    expect((await withoutToken.get('/me')).expectSuccess()).toEqual({ username: 'alice' });
  });
});
