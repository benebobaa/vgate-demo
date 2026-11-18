---
name: sync-api-tests
description: Keeps a service's vgate regression suite in step with its backend - diffs the backend since the commit the tests were last synced to, updates the vendored contract as a reviewable diff, then the inventory and the Playwright tests for new, changed or removed endpoints, response codes, fields, events, permissions, validation rules, tables and downstream calls, runs the gate and the guard, and reports coverage gaps, findings and which changes need a human. Use whenever a backend changed (a feature, refactor, hotfix, migration or a regenerated openapi.yaml) and its tests need updating, when someone asks to sync, refresh or update the API tests, when the gate fails because the contract moved, or before merging a backend change to see what it breaks. For a service with no tests yet, use generate-api-tests.
---

# Sync API tests

A service's tests are pinned to the backend commit they were last synced to (`backend.syncedCommit` in
`<svc-dir>/service.yaml`) and to the contract vendored at that commit. This pinning is what makes the gate useful: a
backend that changes its behaviour or its API without anyone updating the tests fails. Syncing is the deliberate,
reviewed act of accepting a change. Your job is to make that act precise and to refuse to accept changes nobody
intended.

`<svc-dir>`, the commands, the JSON envelope and the vgate docs are as in `../generate-api-tests/SKILL.md` ("Where
things are").

## The rule

`../generate-api-tests/SKILL.md` ("The rule that makes or breaks this") applies unchanged. For a sync it sharpens into
one question per failing or affected test: **did a source say this behaviour should change?**

- The contract, the README, an ADR, a migration or a ticket in the commit messages says so: update the expectation
  and cite that source.
- The code changed but no source says the behaviour should: that is a regression or an undocumented change. Keep the
  test as it is and record a finding. An expectation moves only with a source, never because "the backend does this
  now".

## Workflow

### Phase 0 - Preflight

1. Read `<svc-dir>/service.yaml`: backend path, `syncedCommit` and `contract` (the contract's path inside the backend
   repository, `openapi.yaml` when absent). When the backend lives in the project's own repository, the commit range
   is the project's history.
2. Decide the target: the backend commit to sync to (default: its current `HEAD`; ask when the working tree has
   uncommitted changes, since uncommitted code is not a stable target). Compare with `git diff --ignore-cr-at-eol`:
   a checkout that differs only in line endings has no real changes.
3. `git -C <backend> log --oneline <synced>..<target>` and `git -C <backend> diff --stat <synced>..<target>`. Nothing
   in between: report that the suite is current and stop.
4. Check the starting point: `git -C <backend> show <synced>:<contract>` must equal the vendored
   `<svc-dir>/openapi.yaml` (ignoring line endings). A difference means someone edited the vendored contract by hand or
   the last sync was incomplete; report it before anything else, because it would be folded silently into this sync's
   diff.
5. `vgate doctor --service <svc> --json`: fix every failed check with the command it names. Then
   `vgate status --service <svc>`: the stack must be up for Phase 4, and its `build` line names the commit the running
   app was built from. It must be the target before Phase 4; restart the stack (`vgate down`, `vgate up`) from the
   target checkout if it is not.

### Phase 1 - Change analysis

Classify every changed file with `../generate-api-tests/references/spec-sources.md` and build a change list.

1. **Contract changes**: diff the backend's contract at the target against the vendored `openapi.yaml`, operation by
   operation: operations added or removed, responses or codes added or removed, request fields, required flags,
   patterns or bounds changed, response fields and stream events added, removed or retyped. Mark each as additive or
   breaking for consumers. Removing or retyping anything a client reads is breaking, and that includes widening a
   response field to allow `null`. Tightening a request (a new required field, a narrower pattern) is breaking too.
   Give each change a "resolves" column naming the finding (`F-…`) or open question (`OQ-…`) it settles, if any, so
   the reviewer sees which breaking changes were asked for. Take the target's contract from git
   (`git -C <backend> show <target>:<contract>`), never from the working tree.
   For every changed schema, list every operation that returns or accepts it and every scenario that reads or sends
   the changed field, and cross-check the affected list of any finding the change resolves. Then search the tests for
   the property names (`grep -rn '<property>' <svc-dir>/tests <svc-dir>/support`): the type checker misses assertions
   such as `toBeNull()` or `?? null` that compile either way.
2. **Behaviour changes behind an unchanged contract**: handlers and services, gates, security configuration,
   migrations, error enums, outbound clients, published events, webhook verification. These are the dangerous ones:
   the contract says nothing moved. Name the scenarios each change can affect.
3. **Irrelevant changes**: tests, build files, documentation that states no rule. List them so the reviewer sees they
   were considered.

### Phase 2 - Update the plan

Update `<svc-dir>/inventory.yaml`: add scenarios for new operations and codes, change scenarios whose rule changed
(with the new source), remove scenarios of removed operations, and move anything unsourced to `openQuestions`. An
open question the change settles gets a `resolution` (format in
`../generate-api-tests/references/inventory-format.md`). Set `backend.commit` to the target.

The two commit fields mean different things. The inventory's `backend.commit` is the commit the plan was written for,
and moves here, before review. `service.yaml` `backend.syncedCommit` is the commit the suite was verified against, and
moves only at the end of Phase 4.

**Stop for review** when the change list contains a breaking contract change or a behaviour change with no source:
present the change list and the plan diff, and continue when the user agrees. Additive, fully sourced changes may
continue straight away.

### Phase 3 - Update contract, types and tests

1. Write the backend's contract at the target (`git show <target>:<contract>`, LF line endings) over
   `<svc-dir>/openapi.yaml` and run `vgate gate --service <svc> --steps typecheck`, which regenerates the types first.
   The type checker points at tests that use a removed or retyped field in a way that no longer compiles; the search
   from Phase 1 finds the rest.
2. A changed outbound call (a third party, a sibling service, a Kafka topic, a Redis key) changes its stub or its
   assertion too (vgate docs `dependencies.md`). A stub follows the provider's contract, never the code's new
   expectation of it. A changed webhook signature scheme changes `service.yaml` `webhooks` only when a source (the
   provider's documentation) says so.
3. Update tests and support code following `../generate-api-tests/references/test-conventions.md`. New scenarios get
   new tests; changed rules change the assertions that encode them; removed operations lose their tests.

### Phase 4 - Run and classify

Run `vgate gate --service <svc> --json` and work from `<reportsDir>/verdict.json` (generate-api-tests, Phase 4). A
failure the known-failures registry names is tolerated and listed under `tests.knownFailures`; every other failure
counts. Classify each one as generate-api-tests Phase 4 does, with the sync question above. Match each failure
(scenario id or Schemathesis check) to an existing `FINDINGS.md` entry. A failure no entry explains is new, and the
report lists it first.

Update `FINDINGS.md`: a finding the change resolved is closed, not deleted, and a finding that still fails is marked
re-verified at the target (format in `../generate-api-tests/SKILL.md`, "FINDINGS.md"). A registered known failure
that now passes fails the gate with "expected to fail ... but passed": the fix landed, and the report proposes
removing its registry entry for a human to make.

Update `backend.syncedCommit` in `service.yaml` to the target only after the suite has run against a backend built
from that target (the `build` line of `vgate status --service <svc>`, Phase 0 step 5). The commit records what the
tests were verified against, not what they were edited for.

### Phase 5 - Guard

Run `vgate guard --service <svc> --base <ref> --json`, with `<ref>` the branch the merge request targets (e.g.
`origin/main`); vgate docs `guard.md` lists its rules. Exit 0 (`auto`): a green gate merges the change with no human.
Exit 1 (`needs-human`): each finding (`rule`, `file`, `detail`) is a place where the sync weakens or moves an
expectation, and a human will approve the merge request. Every finding must trace to an entry of your Phase 1 change
list with its source; a finding that traces to none is an expectation you weakened without a reason, so restore it.

### Phase 6 - Report

Briefly: the commit range, the contract diff (additive and breaking), scenarios added, changed and removed, the gate
result and coverage, findings with evidence and proposed known-failure entries, open questions, and the guard's
decision with each finding and the source that justifies it. A reviewer of the sync should be able to judge each
accepted change, and each one that needs their approval, from this report alone.
