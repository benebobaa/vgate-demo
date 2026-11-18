# vgate-demo

A live example of [vgate](https://github.com/benebobaa/vgate): pull requests that verify and merge themselves, or ask
one specific question.

- `app/server.ts` is a small notes API (API key, console session, a stream, a signed webhook).
- `regression/notes/` is its verification: the contract, the test plan, the tests. Agents write and maintain it.
- `.github/workflows/vgate.yml` (installed by `vgate init --ci github`) runs on every pull request: the affected
  services' gate and guard, then one decision.

| A pull request that... | vgate says | What happens |
| --- | --- | --- |
| changes the app and keeps the spec, low risk | **merge** | merges itself |
| changes the API contract, or touches a risky path | **needs approval** | waits for one reviewer, with the question in the PR comment |
| breaks behaviour the spec promises | **blocked** | cannot merge |

Policy lives in `vgate.yaml` (`policy.autoMerge: low`). Try it: `curl -fsSL https://vgate.benelabs.tech/install.sh | sh`.
