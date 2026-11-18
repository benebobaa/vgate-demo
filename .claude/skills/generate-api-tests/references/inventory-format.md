# inventory.yaml

The test plan of one service: what every operation must do, where that rule comes from, and how each documented
response will be reached. Humans review it before tests exist; the coverage gate later checks that every scenario
id appears in a test.

## Scenario ids

`<AREA>-<STATUS>[-<CODE>][-<DETAIL>]`, unique in the file, upper-case, e.g. `ORD-201`, `ORD-409-DUPLICATE`,
`ORD-400-VALIDATION-QUANTITY`. `AREA` is a short tag per operation (`ORD` for placing an order). Cross-cutting
scenarios use `AUTH-` (credentials), `GATE-` (account states) and the matrix (below) generates its own cases. Tests
put the id in square brackets at the start of their title: `[ORD-409-DUPLICATE] the same idempotency key with another
body is refused`.

## Shape

```yaml
service: orders
contract: openapi.yaml
backend: { repo: ../.., commit: 1a2b3c4 }

sources:                 # every document read, so a reviewer can re-check the plan
  - openapi.yaml
  - README.md
  - internal/orders/handler.go

personas:                # identities the scenarios use; provisioned ones are built through the API
  customer: { kind: seeded, role: customer }
  support: { kind: seeded, role: support }
  suspended: { kind: provisioned, state: a customer account suspended by support }

auth:                    # how a caller is authenticated and what each failure answers
  scenarios:
    - id: AUTH-401-MISSING
      title: a call without a credential is refused
      expect: { status: 401, error: unauthorized }
      sources: [README.md#authentication, openapi.yaml 401]

gate:                    # checks applied before the endpoint's own permission
  order: [authenticated, account active, permission]
  states:
    suspended: { status: 403, error: account_suspended }
  exempt: [GET /health]
  sources: [README.md#accounts]

conventions:             # repo-wide rules the contract cannot express; scenarios like any other
  scenarios:
    - id: CONV-415-JSON-ONLY
      title: a write without a JSON body is refused
      expect: { status: 415, error: unsupported_media_type }
      sources: [README.md#conventions]

matrix:                  # role x operation; one generated case per cell
  roles:
    customer: [ORDER_CREATE, ORDER_VIEW_OWN]
    support: [ORDER_VIEW_ANY, REFUND]
  denied: { status: 403, error: forbidden }   # a role without the operation's permission
  sources: [migrations/0003_roles.sql, the handlers' permission checks]

operations:
  - id: createOrder                      # the contract's operationId
    operation: POST /orders
    area: ORD
    summary: Charges the customer through the payment provider, stores the order, publishes orders.created
    permission: ORDER_CREATE             # null when the operation has none
    gate: applies                        # applies | exempt
    request: CreateOrderRequest
    checkOrder:                          # which answer wins when a request breaks several rules (from the sources;
      - validation (400), before the permission check       # illustrative here, derive the real order per service)
      - idempotency (409) before the charge (402)
    rules:                               # request-level rules, each with its source
      - rule: quantity is an integer from 1 to 99; amount equals quantity x unit price
        sources: [CreateOrderRequest]
    responses:                           # from the skeleton: status -> documented error values
      '201': []
      '402': [payment_declined]
      '409': [idempotency_conflict]
    dbEffects:
      success:
        - table: orders
          change: insert
          values: { status: paid, amount: the charged amount, created_by: the caller }
      failure: nothing written           # or the exact partial effect a source documents
    events:                              # messages published (topic and schema from the service's dependencies)
      success: [orders.created]
      failure: none
    downstream:
      - system: payments
        call: POST /charges with the order reference, once per order
        onFailure: { status: 503, error: payment_unavailable }
    scenarios:
      - id: ORD-201
        title: a paid order is stored, published once and returned
        as: customer
        request: { sku: a seeded product, quantity: 2 }
        expect:
          status: 201
          response: [status is paid, amount is 2 x the unit price]
          db: [one orders row, status paid]
          events: [one orders.created carrying the order id]
          downstream: [one charge with the order reference]
        sources: [README.md#orders, CreateOrderRequest, impl:OrderService#Create]
    excluded:                            # documented answers no black-box test can reach, with the reason
      - { status: '409', code: idempotency_conflict, reason: needs two concurrent requests with one key }

openQuestions:                           # what no source answers, or where sources disagree
  - id: OQ-1
    question: Does a decline after a timeout answer 402 or 503? README says 402, the handler retries first.
    decision: the plan review's answer, and what the plan does meanwhile # added at review
    resolution: the backend commit that settled it, and the sync that verified it # added by a sync, never deleted
```

## Rules for a good inventory

- Every documented (status, code or error value) pair of every operation appears in a scenario's `expect` or in that operation's
  `excluded`. The coverage gate reads per-operation `excluded` entries (with a `reason`) straight from this file.
- Every scenario id here must end up in a test: the coverage gate fails on a planned id without one.
- Every scenario has `sources`. No source means the scenario belongs in `openQuestions`, not in the plan.
- `dbEffects` of a write operation name the tables, the change and the values that matter, including any audit or outbox row.
- `failure` states what a rejected call writes, which is usually nothing.
- Cross-cutting behaviour (auth, gate, matrix) is written once at the top, not repeated per operation.
- A streaming operation's scenarios cover a complete stream with its terminal event and the errors answered before
  the stream starts. A webhook operation's cover a valid, a forged, an unsigned and a too-old delivery, and a replay.
- A call to a stubbed provider has a scenario for each provider answer a source says the service handles (success,
  decline, outage, timeout); the stubs' coverage report shows the provider answers no test simulates.
- Prefer one scenario per behaviour. Many inputs of one rule (several invalid quantities) are one scenario whose
  test is table-driven.
