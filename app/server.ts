/**
 * The example service (README.md, openapi.yaml): an in-memory notes API. It is the system under test of the
 * framework's own example suite, written to follow its README; it is not part of the framework.
 *
 *   EXAMPLE_PORT=8090 tsx services/example/server.ts
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

interface Note {
  id: string;
  title: string;
  body: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  /** Set by a `note.flagged` webhook (rule 11). */
  flagged?: boolean;
}

type ErrorKind = 'bad_request' | 'unauthorized' | 'forbidden' | 'not_found';

const port = Number(process.env.EXAMPLE_PORT ?? 8090);
// A Map, not an object literal: on a plain object a lookup of "constructor" or "__proto__" finds a built-in property,
// so a key named after one would have authenticated.
const keys = new Map<string, 'writer' | 'reader'>([
  [process.env.EXAMPLE_WRITER_KEY ?? 'writer-key', 'writer'],
  [process.env.EXAMPLE_READER_KEY ?? 'reader-key', 'reader'],
]);
const notes = new Map<string, Note>();
// Rule 9: console accounts that log in with a password and get a session cookie.
const accounts = new Map<string, string>([['alice', process.env.EXAMPLE_ALICE_PASSWORD ?? 'alice-pass']]);
const sessions = new Map<string, { username: string; csrf: string }>();
const SESSION_COOKIE = 'example_session';
// Rule 11: the payment provider's signing secret, and how old a delivery may be.
const webhookSecret = process.env.EXAMPLE_WEBHOOK_SECRET ?? 'whsec-example';
const WEBHOOK_TOLERANCE_S = 300;
const TAG = /^[a-z0-9-]{1,20}$/;
let lastTime = 0;

/** Strictly increasing UTC timestamps, so an update always moves `updatedAt` (README rule 5). */
function now(): string {
  lastTime = Math.max(Date.now(), lastTime + 1);
  return new Date(lastTime).toISOString();
}

class Reject extends Error {
  constructor(
    readonly status: number,
    readonly kind: ErrorKind,
    message: string,
  ) {
    super(message);
  }
}

const codePoints = (text: string) => [...text].length;

class Unauthenticated extends Reject {
  constructor(
    message: string,
    readonly challenge: 'ApiKey' | 'Session',
  ) {
    super(401, 'unauthorized', message);
  }
}

function send(
  res: ServerResponse,
  status: number,
  body?: unknown,
  headers: Record<string, string | string[]> = {},
): void {
  res.setHeader('X-Request-Id', randomUUID());
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}

async function readRaw(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function parseBody(req: IncomingMessage, raw: string): unknown {
  const type = req.headers['content-type'] ?? '';
  if (!/^application\/json\s*(;|$)/i.test(type))
    throw new Reject(400, 'bad_request', 'the body must be application/json');
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Reject(400, 'bad_request', 'the body is not valid JSON');
  }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  return parseBody(req, await readRaw(req));
}

function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return undefined;
}

/** Rule 9: the session of the cookie, or 401. */
function session(req: IncomingMessage): { id: string; username: string; csrf: string } {
  const id = cookie(req, SESSION_COOKIE);
  const found = id === undefined ? undefined : sessions.get(id);
  if (!id || !found) throw new Unauthenticated('a valid session cookie is required', 'Session');
  return { id, ...found };
}

function login(raw: unknown): string {
  const input = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const { username, password } = input;
  if (typeof username !== 'string' || typeof password !== 'string' || Object.keys(input).length !== 2)
    throw new Reject(400, 'bad_request', 'username and password are required, nothing else');
  if (accounts.get(username) === undefined || accounts.get(username) !== password)
    throw new Unauthenticated('unknown username or wrong password', 'Session');
  return username;
}

/** Rule 11: `X-Example-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`, at most 5 minutes old. */
function verifySignature(header: string | undefined, raw: string): boolean {
  const parts = new Map(
    (header ?? '').split(',').map((part) => {
      const [key, ...value] = part.trim().split('=');
      return [key, value.join('=')] as const;
    }),
  );
  const t = parts.get('t');
  const v1 = parts.get('v1');
  if (!t || !/^\d+$/.test(t) || !v1) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > WEBHOOK_TOLERANCE_S) return false;
  const expected = createHmac('sha256', webhookSecret).update(`${t}.${raw}`).digest('hex');
  return expected.length === v1.length && timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
}

/** Rule 10: one `word` event per word of the title and the body, then `data: [DONE]`. */
function streamWords(res: ServerResponse, note: Note): void {
  res.setHeader('X-Request-Id', randomUUID());
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const words = `${note.title} ${note.body ?? ''}`.split(/\s+/).filter(Boolean);
  words.forEach((word, index) => res.write(`event: word\nid: ${index}\ndata: ${JSON.stringify({ index, word })}\n\n`));
  res.end('data: [DONE]\n\n');
}

function noteInput(raw: unknown): Pick<Note, 'title' | 'body' | 'tags'> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new Reject(400, 'bad_request', 'the body must be an object');
  const input = raw as Record<string, unknown>;
  const unknown = Object.keys(input).filter((key) => !['title', 'body', 'tags'].includes(key));
  if (unknown.length > 0) throw new Reject(400, 'bad_request', `unknown field ${unknown[0]}`);
  const { title, body = null, tags = [] } = input;
  if (typeof title !== 'string' || codePoints(title) < 1 || codePoints(title) > 80)
    throw new Reject(400, 'bad_request', 'title must be 1 to 80 characters');
  if (body !== null && (typeof body !== 'string' || codePoints(body) > 2000))
    throw new Reject(400, 'bad_request', 'body must be null or at most 2000 characters');
  if (!Array.isArray(tags) || tags.length > 5 || new Set(tags).size !== tags.length)
    throw new Reject(400, 'bad_request', 'tags must be at most 5 distinct tags');
  for (const tag of tags as unknown[]) {
    if (typeof tag !== 'string' || !TAG.test(tag))
      throw new Reject(400, 'bad_request', 'tags must match ^[a-z0-9-]{1,20}$');
  }
  return { title, body: body, tags: tags as string[] };
}

function listQuery(url: URL): { limit: number; tags: string[] } {
  const rawLimit = url.searchParams.get('limit');
  const limit = rawLimit === null ? 20 : /^\d+$/.test(rawLimit) ? Number(rawLimit) : NaN;
  if (!(limit >= 1 && limit <= 100)) throw new Reject(400, 'bad_request', 'limit must be an integer from 1 to 100');
  const tags = url.searchParams.getAll('tag');
  if (!tags.every((tag) => TAG.test(tag))) throw new Reject(400, 'bad_request', 'tag must match ^[a-z0-9-]{1,20}$');
  return { limit, tags };
}

function find(id: string): Note {
  const note = notes.get(id);
  if (!note) throw new Reject(404, 'not_found', `no note ${id}`);
  return note;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const method = req.method ?? 'GET';
  if (url.pathname === '/health') {
    if (method !== 'GET') return send(res, 405, undefined, { Allow: 'GET' });
    return send(res, 200, { status: 'UP' });
  }

  // Rule 9: the console session, cookie-authenticated (no API key).
  if (url.pathname === '/session') {
    if (method === 'POST') {
      const username = login(await readBody(req));
      const id = randomUUID();
      const csrf = randomUUID();
      sessions.set(id, { username, csrf });
      return send(
        res,
        200,
        { username, csrfToken: csrf },
        { 'Set-Cookie': `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax` },
      );
    }
    if (method === 'DELETE') {
      const current = session(req);
      if (req.headers['x-csrf-token'] !== current.csrf)
        throw new Reject(403, 'forbidden', 'X-CSRF-Token must carry the token of this session');
      sessions.delete(current.id);
      return send(res, 204, undefined, { 'Set-Cookie': `${SESSION_COOKIE}=; Path=/; Max-Age=0` });
    }
    return send(res, 405, undefined, { Allow: 'POST, DELETE' });
  }
  if (url.pathname === '/me') {
    if (method !== 'GET') return send(res, 405, undefined, { Allow: 'GET' });
    return send(res, 200, { username: session(req).username });
  }

  // Rule 11: the payment provider's webhook, signed instead of keyed.
  if (url.pathname === '/webhooks/notes') {
    if (method !== 'POST') return send(res, 405, undefined, { Allow: 'POST' });
    const raw = await readRaw(req);
    const signature = req.headers['x-example-signature'];
    if (!verifySignature(typeof signature === 'string' ? signature : undefined, raw))
      throw new Reject(403, 'forbidden', 'the signature is missing, wrong or too old');
    const event = parseBody(req, raw) as Record<string, unknown> | null;
    if (!event || event.type !== 'note.flagged' || typeof event.noteId !== 'string')
      throw new Reject(400, 'bad_request', 'expected { type: "note.flagged", noteId }');
    notes.set(event.noteId, { ...find(event.noteId), flagged: true });
    return send(res, 204);
  }

  const words = /^\/notes\/([^/]+)\/words$/.exec(url.pathname);
  if (words) {
    if (method !== 'GET') return send(res, 405, undefined, { Allow: 'GET' });
    if (!keys.get(String(req.headers['x-api-key'] ?? '')))
      throw new Unauthenticated('a valid X-Api-Key is required', 'ApiKey');
    return streamWords(res, find(decodeURIComponent(words[1])));
  }

  const item = /^\/notes\/([^/]+)$/.exec(url.pathname);
  const allowed = url.pathname === '/notes' ? ['GET', 'POST'] : item ? ['GET', 'PUT', 'DELETE'] : undefined;
  if (!allowed) throw new Reject(404, 'not_found', `no resource ${url.pathname}`);
  if (!allowed.includes(method)) return send(res, 405, undefined, { Allow: allowed.join(', ') });

  // Rule 1 and 2: the key first, then what it may do, then the request itself.
  const role = keys.get(String(req.headers['x-api-key'] ?? ''));
  if (!role) throw new Unauthenticated('a valid X-Api-Key is required', 'ApiKey');
  if (method !== 'GET' && role !== 'writer') throw new Reject(403, 'forbidden', 'this key may only read');

  if (!item) {
    if (method === 'POST') {
      const input = noteInput(await readBody(req));
      const time = now();
      const note: Note = { id: randomUUID(), ...input, createdAt: time, updatedAt: time };
      notes.set(note.id, note);
      return send(res, 201, note);
    }
    const { limit, tags } = listQuery(url);
    const matching = [...notes.values()]
      .filter((note) => tags.every((tag) => note.tags.includes(tag)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return send(res, 200, { items: matching.slice(0, limit), total: matching.length });
  }

  let id: string;
  try {
    id = decodeURIComponent(item[1]);
  } catch {
    throw new Reject(404, 'not_found', 'no note with that id');
  }
  if (method === 'GET') return send(res, 200, find(id));
  if (method === 'PUT') {
    const input = noteInput(await readBody(req)); // rule 4: the body before the lookup
    const note = { ...find(id), ...input, updatedAt: now() };
    notes.set(id, note);
    return send(res, 200, note);
  }
  find(id);
  notes.delete(id);
  return send(res, 204);
}

createServer((req, res) => {
  handle(req, res).catch((error: unknown) => {
    if (error instanceof Reject) {
      const headers: Record<string, string> =
        error instanceof Unauthenticated ? { 'WWW-Authenticate': error.challenge } : {};
      send(res, error.status, { error: error.kind, message: error.message }, headers);
    } else {
      send(res, 500, { error: 'internal', message: String(error) });
    }
  });
}).listen(port, () => process.stdout.write(`example listening on :${port}\n`));
