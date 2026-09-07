# Agent Evidence Flow

Local, evidence-driven workflow orchestration for AI-assisted software development.

It gives an AI coding session a small, recoverable state machine for planning, implementation, verification, and optional local commits. It does not push branches, open pull requests, publish releases, or write to production systems.

> Modified distribution of [Eysion/local-ai-workflow](https://github.com/Eysion/local-ai-workflow). Non-commercial use only. See [LICENSE](./LICENSE) and [NOTICE.md](./NOTICE.md) for the preserved terms and source attribution.

## Usage

The normal workflow is AI-driven. Install it into your repository, open the repository in an AI coding agent (for example Claude Code or another agent that reads `AGENTS.md`), and describe the task in natural language. The generated `AGENTS.md` and optional Claude hooks tell the agent when to inspect status, create a Run, collect evidence, and verify changes.

```bash
./install.sh /absolute/path/to/your-repository --apply
cd /absolute/path/to/your-repository
# Start your AI coding agent here and describe the task.
```

The underlying CLI can also be called directly for scripting, debugging, or agents that do not load repository instructions:

```bash
workflow start \
  --task-id example-task \
  --request "update the login page" \
  --changed-file src/pages/LoginPage.vue

workflow status
workflow explain
workflow timeline
```

`start` creates a local Run. The workflow then guides the task through planning, implementation, verification, and (when explicitly requested) a local commit. Developers normally only need to prompt the AI agent; direct CLI commands are an advanced interface. Use `workflow --help` for context indexing, sediment, shadow mode, and resume commands.

## Daily workflow

`start` now advances to intake and returns the next action and related historical records. Evidence drafts preserve the Run request, owned paths and acceptance criteria:

```bash
workflow evidence --node intake
workflow resolve --node intake --json '{"acceptanceCriteria":["The expected behavior works"]}'
workflow evidence --node planning
workflow resolve --node planning --json '{"steps":["Implement and verify the change"]}'
workflow resolve --node implementation --json '{"summary":"Implemented the change"}'
workflow sediment
```

Use `--evidence-stdin` or the existing `--evidence-file` option for larger JSON. Successful submissions advance automatically; engine-owned nodes cannot be completed with `resolve`. Failed quality assessments remain waiting. Accepted assessments require passing checks for every intake criterion, linked to the latest fresh verification event. Add `--signal SOLUTION_TRADEOFF` when alternatives need comparison; otherwise candidate and score fields are unnecessary.

```bash
workflow retry --node verification --reason "Repair the failing assertion"
workflow loop check --change "Adjusted the failing behavior"
workflow sediment recommend
workflow sediment reuse --json '{"path":"docs/workflow-sediment/previous-task.md","adopted":true,"helped":true}'
workflow intervention --reason "A person clarified the expected behavior"
workflow metrics
```

Retry reopens implementation and invalidates downstream evidence. Loop checks execute the verifier and measure real time and repeated failing feedback; retries retain the original loop budget. Editing remains the host agent's responsibility. Verification reuses a successful loop check only while owned files and the verification environment remain unchanged.

Initialization prefers an existing `check`/`verify` script, otherwise combines available lint, typecheck, test and build scripts. Configure `coverage: behavior` only for checks that exercise task behavior; static checks alone cannot enable unattended execution. Existing single-command configuration remains supported. See the [Chinese configuration and execution guide](docs/README.zh-CN.md).

Registered tools can execute through `workflow tool execute --capability <id> --json '<input>'`. Budget is reserved before execution, including failed or interrupted calls. Results expire after 30 seconds; `--fresh` bypasses caching, and local context searches always recheck candidate freshness. Fixed read-only MCP bridge commands must be configured by the project; local-first routes require `--local-evidence`. Legacy `tool record` imports audit data and cannot enforce budgets on tools run outside the engine.

Metrics report observed elapsed, execution and waiting time, first-pass rate, repair counts, CLI calls, explicitly recorded human interventions and sediment reuse. Start with `--category bugfix|feature|investigation|maintenance` to group comparable tasks. Execution time measures engine node execution; waiting includes host Agent work and human delay. It is not model compute time.

## Recovery and task selection

`resume` reconciles an interrupted commit against its journal without creating new commits. Use `workflow reconcile --run ID` for an already failed commit node. Pending groups remain waiting until explicitly authorized with `commit --yes`; detected receipts are persisted before continuing.

An unfinished active Run cannot be silently replaced. Use `start ... --replace-active OLD_ID` for a new task, or `workflow activate --run EXISTING_ID --replace-active OLD_ID` to select an existing one. Selection is serialized; this does not isolate concurrent edits. Use separate worktrees for concurrent work.

Owned paths must name exact files and cannot traverse symlinks. Verification freshness includes Git HEAD, content of uncommitted files, and common manifests/lockfiles. Non-Git projects use the supported source-file scan plus common manifests. State files and the current generated sediment are excluded. External services, ignored dependencies and environment variables still require explicit revalidation when they change.

In workspace mode, repeat `--affected-repo ID` for affected repositories. IDs must be configured; the selected repository is included. This enables OpenSpec and cross-repository parity together. Write the proposal before submitting its contract. Parity evidence must cover each affected repository and pass before sediment or commit. Production bug intake requires symptom, impact, rollback and verification limits before implementation.

Long stdout/stderr is stored once under the state directory, with a preview and SHA-256 reference in events. Read it with `workflow log --digest SHA256 [--offset N] [--limit N]`; use `status --verbose` for full event metadata. Chinese retrieval uses word segmentation and recognizes short terms.

## Measuring a baseline

Collect real tasks of comparable scope, recording actual human interventions rather than inferring them. CLI counts exclude help, hooks, repository discovery and metrics queries; direct runtime API calls are not CLI calls. Missing historical events cannot be reconstructed.

```bash
workflow metrics > .workflow/state/baseline.json
workflow metrics --baseline .workflow/state/baseline.json
```

The comparison reports category-level observed deltas. A saved snapshot and a later snapshot may overlap; they are not automatically independent experimental groups. No business-task baseline is bundled or simulated as real usage.

## Requirements

- Node.js 20.19+
- pnpm (recommended) or npm

## Install

```bash
git clone https://github.com/woyaofei303/agent-evidence-flow.git
cd agent-evidence-flow
pnpm install
pnpm link --global
workflow --help
```

To install the workflow into another repository:

```bash
./install.sh /absolute/path/to/target
./install.sh /absolute/path/to/target --apply
```

The first command previews changes. The second applies them. The installer does not stage, commit, or push files.

The CLI name `workflow`, installed path `tooling/ai-workflow/`, and managed block markers remain compatible with existing installations.

## How it works

Runs move through a finite state machine backed by a workflow DAG. Structured events record transitions and evidence; leases and journals make interruption and commit reconciliation recoverable. Planning, quality, loop, and evidence-routing policies are deterministic and testable. The local context index narrows search results but never replaces source review or verification.

The detailed design and implementation notes are in [docs/README.zh-CN.md](./docs/README.zh-CN.md).

## Repository layout

```text
cli/       Command-line entry point
src/       Workflow engine and adapters
scripts/   Installer and demos
templates/ Planning and evidence templates
workflows/ Built-in workflow definitions
test/      Node.js test suite
```

## Development

```bash
pnpm install
pnpm test
pnpm workflow -- help
```

## License

The upstream-provided [LICENSE](./LICENSE) is preserved verbatim, including its non-commercial restriction and copyright notice. Commercial use, paid services, advertising, and use in commercial products or workflows are not permitted by that file. It labels itself PolyForm Noncommercial 1.0.0 but contains a plain-language summary; package metadata therefore points to the supplied file rather than claiming a standard license text. See [NOTICE.md](./NOTICE.md) for provenance and modifications.
