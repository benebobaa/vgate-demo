---
name: generate-api-tests
description: Onboards a backend service into a vgate project and generates its black-box regression suite from the backend's own sources - first a reviewable test plan (inventory.yaml), then Playwright tests covering every documented response of every endpoint, the role and permission matrix, streams, webhooks, dependency calls and database side effects, then runs the vgate gate and reports where the backend disagrees with its spec. Use whenever someone wants to onboard a service, generate or write API tests or a regression suite for a backend, cover all endpoints, or build or review a backend's test plan, even if they only say "onboard X", "test this backend" or "plan the tests for <repo>". For a service that already has tests and a changed backend, use sync-api-tests.
---

# Generate API tests

You turn a backend into a regression gate: deterministic Playwright tests, committed and reviewed like code, that run
on every change and fail when behaviour moves. You are the author, never the gate itself: once the tests exist, no
model decides pass or fail.

The vgate runtime does the generic work: it holds every response to the vendored OpenAPI contract (documented
status, schema with no undocumented fields, header rules, datetime offsets, each event of a stream), records observed
responses for the coverage gate, and gives tests typed calls, every kind of login, database access, signed webhooks,
contract-checked dependency stubs, run-unique data and faults. Your job is everything service-specific.

## Where things are

- **The project** is the repository with `vgate.yaml`. A service lives in `<servicesDir>/<svc>/` (`servicesDir` from
  `vgate.yaml`, default `regression`); below, `<svc-dir>`. The runtime is not in the project: tests reach it as
  `@vgate/framework/...`.
- **The backend** usually lives in the same repository (`service.yaml` `backend.repo: ../..`, or the service's own
  folder in a monorepo); it may also be a separate checkout (`backend.repo: ${<SVC>_REPO:-../path}`).
- **Commands** are the installed `vgate` binary (`pnpm vgate` inside the vgate source repository). Under `--json`
  every command answers `{ command, ok, exitCode, summary, data, next }`: branch on `exitCode` (0 yes, 1 the
  verification ran and failed, 2 a wrong call, 3 nothing verified: machine, project or stack not ready) and follow
  `next`. `vgate help --json` lists every command.
- **Docs** live in the vgate repository, not in the project: `https://github.com/benebobaa/vgate/blob/main/docs/`
  (below, _vgate docs_).

## The rule that makes or breaks this

**Expectations come from the spec, never from what the backend returns today.**

A model asked to "write tests for this API" tends to call the endpoint, look at the answer and assert it. The test
then passes by construction and the gate encodes today's bugs as the baseline. It also hides the class of bug that
matters most: the tester's assumption matching the code while the real requirement says otherwise.

So:

- Derive every expected status, code, field value, event, row and header from a cited source: the contract, the
  README's rules, ADRs, error-code enums, permission annotations, validation rules, migrations, the security
  configuration. `references/spec-sources.md` says where each lives and which source wins when two disagree.
- Write the expectation before you run the test. Running is how you check the test, not how you write it.
- When a test fails and the test is right (its expectation matches a cited source), you have found a mismatch between
  the backend and its spec. Keep the assertion, record it in `<svc-dir>/FINDINGS.md` and leave the test failing:
  whether it is a backend bug or a spec that needs updating is a human decision. Accepting it as a **known failure**
  is a human decision too: `<svc-dir>/known-failures.yaml` belongs to people (the guard sends every change to it to a
  human). Your part is the proposal: in your report, give each finding its ready-to-paste entry (`id`, `ticket`,
  `owner`, `expires`, `reason`; vgate docs `known-failures.md`).
- When no source says what should happen, put the question in the inventory's `openQuestions` and leave that
  scenario out until someone answers.

## Workflow

Work through the phases in order. Phase 2 ends with a stop for human review unless the user explicitly asked you to
go end to end.

### Phase 0 - Preflight

1. No `vgate.yaml` in the repository: run `vgate init --service <svc>` (add `--ci github` when the repository uses
   GitHub Actions). If `<svc-dir>/inventory.yaml` and tests already exist, this is a sync: switch to sync-api-tests.
2. Locate the backend and its contract (ask if neither is evident), note the backend's current commit
   (`git -C <backend> rev-parse --short HEAD`) and whether the contract has uncommitted changes. The commit becomes
   `syncedCommit`.
3. `vgate doctor --json`; fix every failed check with the command its `fix` (and the result's `next`) names.
   `vgate doctor --fix` runs the ones that touch only the project and the runtime cache. Once the service is
   onboarded, `vgate doctor --service <svc>` also checks its config, contract types and stack. Tests are only
   meaningful against a running service.

### Phase 1 - Onboard the service

Skip what is already done (a partly onboarded service resumes where it stopped). Read `references/onboarding.md`,
then fill `<svc-dir>`:

- `openapi.yaml`: the backend's contract at the recorded commit, LF line endings. This vendored copy is the approved
  behaviour; only sync-api-tests changes it.
- `service.yaml`: rules, coverage exclusions, Schemathesis settings and the `local` environment, filled only from
  sources; each rule carries a comment naming its source.
- `stack.sh` (`up | down | status | reset`) and `support/fixtures.ts`. Contract types (`<svc-dir>/generated/`) come
  from `vgate doctor --fix` and from every gate's typecheck.

Then check what decides whether contract validation can pass at all, and raise each mismatch as an early finding:

- **Nullability.** Contract generators often type a field as plain `string` while the backend serialises `null`
  (an optional relation, a missing email). The framework rejects such a response, so every scenario meeting one fails
  on the contract check before any assertion runs. Compare response schemas with the sources; accepting nulls
  (`rules.optionalPropertiesNullable`) loosens the contract and is the human's decision.
- **Streams.** An operation answering `text/event-stream` whose events the contract describes only as `type: string`
  can be checked for framing and its terminal event, never for its data. Record a finding asking for an `itemSchema`
  (vgate docs `streaming.md`).

### Phase 2 - Inventory (the test plan)

1. Generate the skeleton from the contract with `vgate inventory --service <svc> --write` (it writes
   `<svc-dir>/inventory.skeleton.yaml`: every operation with its documented responses, status to codes, every
   judgement TODO), then build `<svc-dir>/inventory.yaml` from it in the shape of `references/inventory-format.md`
   and delete the skeleton file.
2. Read the backend's sources (`references/spec-sources.md`) and fill in: summary, permission, gate behaviour, the
   order of checks (which code wins when a request breaks several rules), database effects on success and on
   failure, events published, downstream calls, webhooks received. Add the personas the scenarios need.
3. Write the scenarios of each operation. Every documented (status, code) pair needs at least one scenario or an entry
   under the operation's `excluded` with the reason it cannot be reached from outside (the coverage gate reads those
   exclusions from the plan; only service-wide exclusions belong in `service.yaml`). Generators often document
   standard errors on every endpoint, including ones that cannot happen there: exclude them with the reason and note
   that the backend could trim its contract. Add the cross-cutting scenarios: missing, expired and wrong credentials
   for every auth kind the service accepts, every gate state per operation, the role matrix (each built-in role
   against each operation), and the repo-wide conventions the contract does not express. Format and id convention:
   `references/inventory-format.md`.
4. Every scenario names its `sources`. A scenario you cannot source goes to `openQuestions`.
5. **Stop and present the plan**: number of operations, scenarios, documented pairs covered versus excluded, the open
   questions, the early findings, and anything in the sources that contradicts itself. Ask for review. Continue only
   when the user agrees, or if they asked you to go end to end from the start.

### Phase 3 - Generate the tests

Read `references/test-conventions.md` first; it is the framework's API and the quality bar.

The coverage gate fails on any planned scenario id that no collected test carries in its title, so write the tests
for the whole plan in one go. If the plan is too large for one change, cut it into waves in the plan itself (move the
later wave's scenarios out of the inventory into a `waves:` note) rather than leaving planned scenarios without tests.

- `support/`: personas (users in each state, built through the API, not by writing rows), data builders, small helpers.
- `tests/<area>/*.spec.ts`: one file per operation group, every test titled with its scenario id, e.g.
  `[ORD-409-DUPLICATE] the same idempotency key with another body is refused`.
- `tests/authz/`: the role matrix and gate states as table-driven tests.
- `tests/faults/`: dependency failures (only in disposable environments).
- A write scenario asserts the rows it wrote, with their values, the events it published and the audit trail. A
  rejected write asserts that it wrote and published nothing. A read scenario asserts the fields that carry meaning,
  not the whole body (the contract already checks the shape).

### Phase 4 - Run and classify

`vgate up --service <svc>`, then `vgate gate --service <svc> --json`. The gate runs every step (selftest, typecheck,
lint, test, contract, coverage) even after one fails and writes the verdict to `<reportsDir>/verdict.json`: each
failed step with its log, each failed test with its scenario id, file, line and message, the coverage gaps, and the
known failures the registry tolerated. The verdict is the source of truth; work from it, never from scrolled output.
Re-run what you touched with `--steps`, e.g. `--steps typecheck,lint,test`; a partial run is marked
`complete: false`, so finish on a full run. Classify each failure:

| Failure | What you do |
|---|---|
| The test is wrong (bad data, wrong helper, an expectation no source supports) | Fix the test |
| The backend disagrees with a cited source | Keep the test, add an entry to `FINDINGS.md`, propose its known-failure entry |
| The environment is broken (exit 3, stack down, stale data) | `vgate doctor --service <svc>`, then fix what it names or report it; the test stays as is |

Failures of the `contract` step (Schemathesis on read-only operations) and of `coverage` are classified the same way.
Repeat until every remaining failure is a recorded finding.

### Phase 5 - Report

Tell the user, briefly: coverage (documented responses covered, excluded, gaps), the findings with their evidence
(scenario id, X-Request-Id, the source that says otherwise) and their proposed known-failure entries, open questions,
and how to run the gate (`vgate gate --service <svc>`).

## FINDINGS.md

One entry per mismatch, newest first:

```markdown
## [ORD-201] The order total ignores the quantity
- Expected: `orders.amount` is quantity x unit price (README "Orders"; CreateOrderRequest docs)
- Actual: stored the unit price for a quantity of 2 (X-Request-Id 0b7c...)
- Test: tests/orders/create.spec.ts
- Decision: open (backend bug or spec change?)
```

The summary table at the top has one row per entry, with a severity. When a sync settles an entry, keep the entry
and set its severity to `Resolved`. Replace its `Decision:` line with `Decision: resolved <date>: <the commit and
what it changed>` and state that its tests now pass. Entries that still fail after a sync get one line under the
file's header: `Re-verified <date> at <commit>: F-… unchanged`, with fresh X-Request-Ids.
