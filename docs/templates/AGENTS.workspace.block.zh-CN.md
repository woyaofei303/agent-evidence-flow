<!-- local-ai-workflow:start -->
## Agent Evidence Flow — Workspace Mode

本目录使用一套中央本地状态机管理多个独立 Git 仓库。工作流引擎、运行状态和 Hook 只位于父级目录；安装器不得把 `tooling/ai-workflow/`、`.workflow/` 或 Hook 写入子仓库。

先查看仓库注册表：

```bash
node tooling/ai-workflow/cli/workflow.mjs repos
```

所有运行命令必须显式选择仓库：

```bash
node tooling/ai-workflow/cli/workflow.mjs status --repo <id>
node tooling/ai-workflow/cli/workflow.mjs start --repo <id> \
  --task-id task-id \
  --request "request summary" \
  --changed-file path/relative/to/selected/repository
```

`--changed-file` 始终相对于所选子仓库，不得填写父级路径或另一个仓库的路径。开始实现前，还必须读取所选子仓库自己的业务、架构和验证说明。

### Planning gate

每个 Run 都必须经过 planning，但 OpenSpec 只在契约信号命中时强制：

父级 Run context 会记录 `planningMode` 和 `executionMode`；模式决策集中保存在父级状态中，不写入子仓库的旧工作流目录。

- `inline`：默认的模型短计划。
- `structured`：多步骤、多组件、多验收项、可恢复或长任务；使用 `tooling/ai-workflow/templates/planning/structured-plan.json`。
- `openspec`：`CROSS_REPO`、API、数据、鉴权安全、公开行为或长期设计契约变化；先完成 `openspec-contract`，并在所选子仓库写入 `openspec/changes/<task-id>/proposal.md`。多仓 OpenSpec 可以描述整体契约，但每个子 Git 仍必须建立独立 Run、验证和提交。

通过 `--planning-mode` 可以显式升级，契约类信号不得降级。计划由模型生成和更新，OpenSpec 保存长期契约，父级状态机保存执行和证据，三者不是替代关系。

### Bounded Loop Engineering

### Unattended execution

Prompt 包含“无人值守”（或 `unattended`）时，先评估精确改动范围、自动验证和风险信号。只有合格后才记录 `UNATTENDED` 并请求受限 Loop。宿主 Agent 负责持续推进计划、执行、验证和复盘；状态机负责顺序、预算与证据，不会自行生成代码。默认不 Commit、不 Push。需求不清时先补齐；外部副作用或敏感操作必须改为有人监督，不能进入无人值守。

长任务本身不会触发 Loop，只会升级为 structured planning。仅当命中 `LOOP_REQUESTED`、`ITERATIVE_ACCEPTANCE` 或 `EXPECTED_MULTIPLE_ITERATIONS`、所选子仓库存在自动验证命令，且没有 `REQUIREMENT_UNCLEAR`、`EXTERNAL_SIDE_EFFECT`、`SENSITIVE_OPERATION` 时，才增加 `loop-execution`。

默认最多 6 轮、连续 2 轮无进展停止、60 分钟截止。每轮改动后调用 `workflow loop check --change "本轮改动"`；引擎实际运行验证、记录耗时与反馈，并在预算耗尽或无进展时停止。最终成功检查在文件未变化时直接复用。Workspace 的每条命令都要携带 `--repo <id>`。

### Managed repositories

{{REPOSITORY_TABLE}}

{{HETEROGENEOUS_NOTICE}}

### 子仓库旧工作流停用规则

父级 `tooling/ai-workflow/` 是唯一有效工作流引擎。子仓库中已有的 `.agents/`、`.workflow/`、`tooling/ai-workflow/`、`public/workflow/`、旧 Hook，以及 `AGENTS.md` 中指向这些入口的旧工作流指令全部标记为 inactive：不得读取为工作流规则，不得调用，也不得用它们替代父级 CLI。

子仓库 `AGENTS.md` 中与业务行为、架构、安全和真实项目验证有关的约束仍需遵守；与旧工作流入口冲突的部分不进入本 Workspace 执行链。不要因为它们 inactive 就自动删除或改写子仓库文件。

{{LEGACY_WORKFLOW_NOTICE}}

### Workspace special flow

1. 用 `repos` 核对仓库 ID、技术栈和验证命令。
2. 用 `--repo <id>` 创建或恢复该仓库的 Run；不同仓库使用独立 Run。
3. 验证命令在所选子仓库根目录执行，中央状态保存在父级 `.workflow/state/<id>/`。
4. 任务要求沉淀时，沉淀写入所选子仓库配置的目录；这是任务产物，不是安装行为。
5. Shadow、Writer Lock、精确暂存和本地提交都只作用于所选子仓库。
6. 多仓需求分别验证、沉淀和提交；Git 不提供跨仓原子事务，不得声称多个仓库可以一次性原子提交。

只有用户明确授权本地提交时，`start` 才增加 `--commit`。工作流不 push、不创建 PR、不发布。

### 证据提交与失败恢复

使用 `workflow evidence --node <id>` 取得已填入请求、路径和验收项的模板及待填字段；通过 `workflow resolve --node <id> --json '{"字段":"值"}'` 或 `--evidence-stdin` 提交剩余字段。无需创建临时 JSON 文件，成功提交会自动推进。质量评估须将每条验收绑定到最新成功验证事件；仅在 `SOLUTION_TRADEOFF` 时要求候选比较；未通过时保持 waiting。

验证失败后调用 `workflow retry --node verification --reason "修复原因"`，回到 implementation 并使下游旧证据失效，再修改和重验。中断提交由 resume 对账，已失败的提交用 `workflow reconcile --run ID` 对账；Loop 修复不重置预算。只有行为验证才能启用自动迭代，`git diff --check`、lint 和 build 单独不足以证明功能验收。

`workflow sediment recommend` 检索历史沉淀，`workflow sediment reuse --json '{"path":"记录路径","adopted":true,"helped":true}'` 登记实际采纳结果；`workflow metrics` 汇总完成耗时、首次验证通过率、修复和复用数据。实际人工介入由 `workflow intervention --reason "原因"` 显式记录。

`workflow tool execute --capability <id> --json '<输入>'` 在执行前预留预算并记录真实结果。MCP 须配置固定的只读桥接命令；local-first 模式须用 `--local-evidence` 说明本地证据为何不足。`tool record` 仅导入审计记录，不能控制调用方自行执行的工具。
新任务不得隐式覆盖未结束的 Run；确认切换时显式指定 `--replace-active 旧ID`。已有任务用 `workflow activate --run ID` 选择。跨仓任务添加 `--affected-repo ID`，并完成逐仓一致性证据。新任务添加 `--category bugfix|feature|investigation|maintenance` 以积累可比指标；长日志用 `workflow log --digest SHA256` 按需读取。
<!-- local-ai-workflow:end -->
