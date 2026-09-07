<!-- local-ai-workflow:start -->
## Agent Evidence Flow

This repository uses the local state machine in `tooling/ai-workflow/`. Before starting work, inspect the current run:

```bash
node tooling/ai-workflow/cli/workflow.mjs status
```

For fast context discovery, run `index` and then `search`. The lexical index only narrows candidates; always verify results with `rg` and source review. Rebuild the index when results are marked `stale`.

When no reusable Run exists, use `start` with the request and at least one exact `--changed-file` path. Add `--commit` only when the user explicitly authorizes a local commit. Runtime state belongs in `.workflow/state/` and must remain ignored by Git.

- Project: `{{PROJECT_NAME}}`
- Detected stacks: `{{STACKS}}`
- Detection manifests: `{{MANIFESTS}}`
- Default verification: `{{VERIFICATION_COMMAND}}`

Detection initializes the base configuration only. Business rules, architecture boundaries, and sensitive contracts come from the rest of this file and the repository source. Update `.workflow/config.yaml` when the repository changes.

### Planning gate

Every task goes through `planning`; OpenSpec is required only for contract signals. The mode comes from boolean signals in `.workflow/config.yaml`; do not use scores or weights, and do not silently downgrade a recorded mode.

The Run context records `planningMode` and `executionMode`; later nodes must follow those recorded decisions.

- `inline`: a clear, small change; record goal, owned paths, steps, acceptance, and verification with `inline-plan.json`.
- `structured`: multi-step, multi-component, recoverable, or long work; use `structured-plan.json`.
- `openspec`: cross-repository work or API, data, authentication, security, public-behavior, or long-term contract changes; complete `openspec-contract` first and write the proposal under `openspec/changes/<task-id>/`.

The `intake`, `planning`, `implementation`, and `atomic-commit-plan` nodes require their JSON evidence templates. `request` and `ownedPaths` must match the Run exactly. Run creation records Git identity, HEAD, and the workspace snapshot; configured remote patterns must match exactly.

`--changed-file` must be repository-relative, cannot escape the repository, and must name an exact file and cannot traverse a symbolic link. Verification fingerprints controlled paths; later changes invalidate that evidence. A skipped verification never authorizes a local commit.

### Bounded Loop Engineering

Unattended work requires an eligibility check for exact scope, automated verification, and risk signals. The host Agent writes code and reviews results; the state machine controls order, budget, evidence, and stop conditions. It never authorizes commit, push, release, or production writes by itself.

Long work alone does not trigger a loop. A loop requires `LOOP_REQUESTED`, `ITERATIVE_ACCEPTANCE`, or `EXPECTED_MULTIPLE_ITERATIONS`, behavioral automated verification, and no unclear-requirement, external-side-effect, or sensitive-operation signal. The default limit is six rounds, two consecutive no-progress rounds, and 60 minutes. After each code change, call `workflow loop check --change "What changed"`. The engine runs verification, records real elapsed time and stops on unchanged failing feedback or exhausted budgets. A successful unchanged check is reused by verification.

### Evidence and recovery

Use `workflow evidence --node <id>` for a Run-specific draft and missing fields. Submit only the remaining fields with `workflow resolve --node <id> --json '{"field":"value"}'`, or pass JSON on stdin with `--evidence-stdin`. No temporary evidence file is required. Successful CLI submissions advance to the next waiting node. Verification, loop, sediment, shadow and commit use their dedicated commands.

After a failed check, use `workflow retry --node verification --reason "What needs repair"`. This reopens implementation and invalidates all downstream evidence. Editing stays disabled until retry succeeds. Resume reconciles interrupted commits; use `workflow reconcile --run ID` for a failed commit node. Loop retries retain their original budgets.

Review `start` recommendations or run `workflow sediment recommend`. Record actual reuse with `workflow sediment reuse --json '{"path":"docs/workflow-sediment/previous-task.md","adopted":true,"helped":true}'`. Use `workflow metrics` for measured completion time, first-pass rate, repairs and reuse; record actual human interventions with `workflow intervention --reason "..."`.

`workflow tool execute --capability <id> --json '<input>'` reserves budget before running a registered read-only command and records its result. MCP bridges require a fixed command in configuration and a `--local-evidence` explanation when local-first is enabled. `tool record` is an audit import, not an execution gate. Rebuild/search the local context index directly when fresh results are required.

### Quality gate

Initialization creates a `qualityPolicy` from detected verification capabilities. High-risk or negative-feedback signals add `quality-assessment`, which requires evidence from retrieval, source review, verification, or independent review. Every intake acceptance criterion must have a passing check linked to the latest fresh verification event. Declare `SOLUTION_TRADEOFF` only when alternatives need comparison; default assessments omit candidate and score fields. Rejected quality evidence remains waiting.

Run Shadow Mode before committing. Only `workflow commit --yes` may stage and create a local commit. This workflow never pushes, opens pull requests, or publishes releases.
Do not silently replace an unfinished active Run. Explicitly select with `start ... --replace-active OLD_ID` or `workflow activate --run ID --replace-active OLD_ID`. Declare affected workspace repositories with repeated `--affected-repo ID` and complete parity evidence before delivery. Add a task category with `--category bugfix|feature|investigation|maintenance`; read long logs on demand with `workflow log --digest SHA256`.
<!-- local-ai-workflow:end -->
