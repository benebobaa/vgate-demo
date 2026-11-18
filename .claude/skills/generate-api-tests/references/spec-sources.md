# Where expectations come from

Every expectation in the inventory and in a test traces back to one of these sources. Read them before writing
scenarios; cite them in each scenario's `sources`.

## Precedence

When two sources disagree, the higher one wins **and** the disagreement goes to the inventory's `openQuestions`:
a spec that contradicts itself is a finding in its own right.

1. **The contract** (`openapi.yaml`): operations, request schemas (required fields, patterns, enums, bounds),
   documented statuses, the codes named in each response description, response schemas.
2. **Written product rules in the repo**: README conventions, ADRs, `docs/`, runbooks, javadoc that states a rule
   ("the username is compared and stored lowercase").
3. **Declarative code**: annotations and enums that state intent rather than mechanics.
4. **Implementation code**: what the code actually does. Use it to discover effects the higher sources do not state
   (which rows, which audit entries), then check each against 1 to 3. When only the implementation says it, cite it
   with an `impl:` prefix so a reviewer knows the expectation rests on the code alone.
5. **Never the live response.** Running a call shows whether your test works, not what the behaviour should be.

## What to extract, source by source

| Source | Extract |
|---|---|
| Contract | Operations; request fields, required, patterns, enums, min/max; documented statuses and codes; response shapes |
| README / docs | Global rules: allowed methods, paging defaults and bounds, list ordering, datetime format, the gate and its order, exempt endpoints, built-in entities, audit rules, PII rules |
| Error-code enum (e.g. `ResultCode`) | Code to HTTP status to meaning; which module owns which block |
| Controllers | Path, method, permission (`@PreAuthorize`), validated body (`@Valid`), documented-error annotations |
| Request DTOs | Validation annotations (`@NotBlank`, `@Pattern`, `@Size`, `@Min`, `@Max`), normalisation stated in javadoc |
| Security configuration | Authentication (issuer, audience), public or exempt paths, CORS, response headers |
| Gate / filters | The order of checks (authentication, account state, permission, ...) and the answer of each |
| Migrations | Tables and columns, unique constraints (a duplicate means 409), seed rows (built-in roles and permissions) |
| Service implementations | Rows written per operation, audit activity types, actor, old and new values, all-or-nothing transactions |
| Outbound clients | Downstream calls, timeouts, how a downstream failure is mapped (e.g. 503); the provider's own contract or docs for what it can answer |
| Event producers | Topics, payload schemas, when an event is (and is not) published |
| Webhook handlers | Signature scheme, timestamp tolerance, idempotency on a replayed delivery |
| Streaming handlers | Event names and payloads, the terminal event, behaviour when the upstream stops mid-stream |
| The backend's own tests | Hints of intended behaviour (their assertions were reviewed), but they mock dependencies |

## Where things usually live

| Stack | Handlers and permissions | Validation and errors | Security and config | Migrations | Outbound |
|---|---|---|---|---|---|
| Spring Boot | `*Controller.java`, `@PreAuthorize` | DTO annotations (`@NotBlank`, `@Pattern`), `*ErrorCode*` enums, `GlobalExceptionHandler` | `SecurityConfig`, filters, `application*.yml` | Flyway `db/migration/V*.sql`, Liquibase | Feign clients, `RestClient`/`WebClient` beans |
| Go (Fiber, Gin, chi, net/http) | route registration, handler files, auth middleware | `validate:` struct tags, error constructors and code constants | middleware (CORS, CSRF, rate limits), config struct and its env mapping | goose / migrate `*.sql`, sqlc queries | provider client packages, their base-URL config |
| Node (Express, Nest, Fastify) | routers or controllers, guards | zod / class-validator schemas, error classes | middleware, config modules, `.env.example` | Prisma, Knex, TypeORM migrations | SDK or fetch wrappers |

Also read the backend's `AGENTS.md`/`CLAUDE.md`, ADRs and `docs/`: product rules often live there and nowhere else.

## How to cite

Short and greppable, enough for a reviewer to find the line:

- `openapi.yaml POST /orders 409`
- `README.md#refunds`
- `CreateOrderRequest` (a type name is enough when it is unique)
- `migrations/0003_roles.sql`
- `impl:OrderService#Create`

## Commonly missed expectations

- Nullability: the contract says `string`, the backend sends `null` (optional relations, missing emails, empty audit
  values). Check it first; it decides whether contract validation can pass at all.
- Check order: when a request breaks several rules, which code answers. Validation usually runs before the
  permission check, so a caller without the permission who sends a bad body gets 400, not 403.
- Responses the contract documents that cannot happen on that endpoint (a generator adding standard errors
  everywhere, an exempt endpoint listing the gate's codes): exclude with the reason, flag for the backend.
- Which identity is recorded as the actor (`created_by`, audit `user_id`): the id, the username, or a system name.
- Normalisation: lowercase or trimmed identifiers, and duplicates that differ only in case.
- Paging: default size, maximum, out-of-range values bounded rather than rejected, fixed server order.
- Self-actions: acting on your own account or resource where a rule forbids it (e.g. refunding your own order).
- Locked or built-in entities that the app must refuse to change.
- Uniqueness: a second create with the same key, and the code it answers.
- The audit trail: actor, activity type, object, old and new values, masking of personal data.
- Nothing written when a call fails, including a downstream failure halfway through.
- Endpoints exempt from a cross-cutting rule, and that the exemption is exactly as narrow as documented.
