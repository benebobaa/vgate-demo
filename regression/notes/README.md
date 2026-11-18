# notes: the demo service

A small notes API that lives in this repo (`server.ts`), so the framework can be exercised end to end, gate included,
without Docker or another repository: `vgate up --service notes` then `vgate gate --service notes`. It deliberately exercises the parts of the
framework that differ most between backends:

- **Verbs and parameters**: GET, POST, PUT and DELETE, with path and query parameters (including arrays).
- **Auth**: a static API key in `X-Api-Key`, and a console session (cookie plus CSRF token).
- **Streams**: Server-Sent Events (`GET /notes/{id}/words`).
- **Webhooks**: signed by the provider (HMAC-SHA256, `t=..,v1=..`).
- **Body shape**: the resource itself, errors as `{ error }`, no envelope.
- **Datetimes**: UTC (`Z`).
- **Database checks**: none; state is observed through the API.

New services can copy its layout. The backend's own documentation would normally be the spec source; here it is
this file and `openapi.yaml`.

## Rules (the spec the tests cite)

1. Every call except `GET /health` needs an `X-Api-Key`. A missing or unknown key answers 401 `unauthorized` with
   `WWW-Authenticate: ApiKey`, before anything else is checked.
2. Two keys exist: `writer` may do everything, `reader` only `GET`. A reader's write answers 403 `forbidden`; the key
   is checked before the body is validated and before the note is looked up.
3. Validation answers 400 `bad_request` with a message naming the field. Unknown body fields are refused. A body
   that is not JSON, or not sent as `application/json`, is refused with 400 as well.
4. `PUT` validates the body before it looks up the note: an invalid body on an unknown id answers 400, not 404.
5. A new note gets a fresh UUID; `createdAt` and `updatedAt` are its creation time. `PUT` replaces title, body and
   tags, keeps `createdAt` and moves `updatedAt`. Omitted `body` is stored as `null`, omitted `tags` as `[]`.
6. `GET /notes` lists newest first, at most `limit` (default 20). `tag` filters to notes carrying every given tag;
   `total` counts the matching notes before the limit.
7. Every response carries an `X-Request-Id` (UUID); every body is JSON (streams excepted, rule 10); every datetime is
   UTC (`Z`).
8. Data lives in memory: `vgate reset --service notes --yes` restarts the service empty.
9. Console accounts (`alice`) log in with `POST /session` (`username`, `password`, nothing else; 400 otherwise). A
   wrong password answers 401. The answer sets the `example_session` cookie and returns a `csrfToken`. `GET /me`
   needs the cookie and answers the account's `username`. `DELETE /session` needs the cookie and `X-CSRF-Token` with
   the session's token (403 without it); afterwards the cookie no longer works. Every 401 of a session call carries
   `WWW-Authenticate: Session`, of an API-key call `WWW-Authenticate: ApiKey`. The session endpoints take no API key.
10. `GET /notes/{id}/words` (reader or writer key) streams the note as Server-Sent Events: one `word` event per word
    of the title and then of the body, data `{ index, word }` with `index` counting from 0 and `id` equal to it, then
    `data: [DONE]`. The key is checked before the note (401, then 404, both JSON).
11. The payment provider calls `POST /webhooks/notes` with `{ "type": "note.flagged", "noteId" }`, signed:
    `X-Example-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">` with the shared secret. A missing,
    wrong or more than 300 seconds old signature answers 403 and changes nothing; then the body is checked (400),
    then the note (404). Accepted, it answers 204 and the note carries `flagged: true` from then on.
