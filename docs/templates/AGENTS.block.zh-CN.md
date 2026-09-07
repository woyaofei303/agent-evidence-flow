<!-- local-ai-workflow:start -->
## Agent Evidence Flow

本仓库使用 `tooling/ai-workflow/` 中的本地状态机。开始任务前先运行：

```bash
node tooling/ai-workflow/cli/workflow.mjs status
```

需要快速定位候选上下文时，先执行 `node tooling/ai-workflow/cli/workflow.mjs index`，再用 `search --query "关键词"`。这是本地 lexical 索引，不连接向量库；检索结果只用于缩小范围，必须以 `rg` 和源码阅读复核，并在结果标记 `stale` 后重建索引。

没有可复用的 Run 时，用 `start` 登记请求和任务拥有的至少一个精确 `--changed-file` 路径。只有用户明确授权本地提交时才增加 `--commit`。运行状态位于 `.workflow/state/`，必须保持 Git 忽略。

- 项目：`{{PROJECT_NAME}}`
- 自动识别技术栈：{{STACKS}}
- 识别依据：{{MANIFESTS}}
- 默认验证：`{{VERIFICATION_COMMAND}}`

检测结果只用于初始化基础配置；业务规则、架构边界和敏感契约仍以本文件其余项目说明及仓库源码为准。若仓库结构改变，应同步更新 `.workflow/config.yaml`。

### Planning gate

每个任务都必须经过 `planning`，但不强制每个任务创建 OpenSpec。模式由 `.workflow/config.yaml` 的布尔信号确定，不使用评分或权重：

Run context 会记录 `planningMode` 和 `executionMode`，后续节点必须按记录执行，不能在实现中静默降级。

- `inline`：默认；范围清楚的单仓小改动，使用 `tooling/ai-workflow/templates/planning/inline-plan.json` 记录 goal、owned paths、steps、acceptance、verification。
- `structured`：多步骤、多组件、多验收项、可恢复任务或长任务；使用 `workflow evidence --node planning` 预填结构化计划。
- `openspec`：跨仓或 API、数据、鉴权安全、公开行为、长期设计契约变化；先完成 `openspec-contract`，再进入 planning。将 `tooling/ai-workflow/templates/planning/openspec-change.md` 适配为 `openspec/changes/<task-id>/proposal.md`，并用 `openspec-contract-evidence.json` 提交该节点证据；契约信号不得降级为 inline/structured。

可显式升级模式：

```bash
node tooling/ai-workflow/cli/workflow.mjs start \
  --task-id task-id \
  --request "request summary" \
  --changed-file src/example.ts \
  --planning-mode structured \
  --signal MULTI_STEP

node tooling/ai-workflow/cli/workflow.mjs resolve \
  --node planning \
  --json '{"tasks":[{"id":"task-1","description":"实施改动","acceptance":"沿用已登记验收项"}]}'
```

`intake`、`planning`、`implementation` 与 `atomic-commit-plan` 不接受自由文本完成标记。必须使用对应 JSON 模板；其中 `request` 和 `ownedPaths` 必须与 Run 记录完全一致。Run 会记录启动时的 Git 身份、HEAD 与工作区变更快照；配置了 `governance.remotePatterns` 时，remote 未精确匹配会拒绝启动。

`--changed-file` 不可为绝对路径、父目录穿越或已有 symbolic link。验证完成后，工作流会对受控路径的内容指纹复查；任何变化都会使本次验证失效。若 `governance.commands.test: null`，verification 节点会明确记录 `skipped`，但该记录不能授权本地提交。

### Bounded Loop Engineering

### Unattended execution

Prompt 包含“无人值守”（或 `unattended`）时，先评估精确改动范围、自动验证和风险信号。只有合格后才记录 `UNATTENDED` 并请求受限 Loop。宿主 Agent 负责持续推进计划、执行、验证和复盘；状态机负责顺序、预算与证据，不会自行生成代码。默认不 Commit、不 Push。需求不清时先补齐；外部副作用或敏感操作必须改为有人监督，不能进入无人值守。

长任务本身不会触发 Loop，只会触发 structured planning。Loop 只有在以下条件同时成立时进入：存在 `LOOP_REQUESTED`、`ITERATIVE_ACCEPTANCE` 或 `EXPECTED_MULTIPLE_ITERATIONS`；项目配置了自动验证命令；且没有 `REQUIREMENT_UNCLEAR`、`EXTERNAL_SIDE_EFFECT`、`SENSITIVE_OPERATION`。

默认最多 6 轮、连续 2 轮无进展停止、60 分钟截止。每轮改动后调用 `workflow loop check --change "本轮改动"`；引擎实际运行验证、记录耗时与反馈，并在预算耗尽或无进展时停止。最终成功检查在文件未变化时直接复用。Workspace 的每条命令都要携带 `--repo <id>`。

### Quality gate

安装器会按已识别的项目验证能力生成 `qualityPolicy`。当任务携带配置中的高风险或负反馈信号时，工作流自动加入 `quality-assessment`：以逐条验收检查和最新验证事件作为接受依据，仅在声明 `SOLUTION_TRADEOFF` 时比较候选。用户不需要选择模型参数；任一验收未通过都不得标记为成功，旧评分字段不参与判断，必须继续验证或澄清。业务风险信号仍须由项目规则或任务事实声明，安装器不会猜测业务领域。

提交前先执行 Shadow Mode。暂存与本地提交只能由 `workflow commit --yes` 执行；工作流不 push、不创建 PR、不发布。

### 证据提交与失败恢复

使用 `workflow evidence --node <id>` 取得已填入请求、路径和验收项的模板及待填字段；通过 `workflow resolve --node <id> --json '{"字段":"值"}'` 或 `--evidence-stdin` 提交剩余字段。无需创建临时 JSON 文件，成功提交会自动推进。质量评估须将每条验收绑定到最新成功验证事件；仅在 `SOLUTION_TRADEOFF` 时要求候选比较；未通过时保持 waiting。

验证失败后调用 `workflow retry --node verification --reason "修复原因"`，回到 implementation 并使下游旧证据失效，再修改和重验。中断提交由 resume 对账，已失败的提交用 `workflow reconcile --run ID` 对账；Loop 修复不重置预算。只有行为验证才能启用自动迭代，`git diff --check`、lint 和 build 单独不足以证明功能验收。

`workflow sediment recommend` 检索历史沉淀，`workflow sediment reuse --json '{"path":"记录路径","adopted":true,"helped":true}'` 登记实际采纳结果；`workflow metrics` 汇总完成耗时、首次验证通过率、修复和复用数据。实际人工介入由 `workflow intervention --reason "原因"` 显式记录。

`workflow tool execute --capability <id> --json '<输入>'` 在执行前预留预算并记录真实结果。MCP 须配置固定的只读桥接命令；local-first 模式须用 `--local-evidence` 说明本地证据为何不足。`tool record` 仅导入审计记录，不能控制调用方自行执行的工具。
新任务不得隐式覆盖未结束的 Run；确认切换时显式指定 `--replace-active 旧ID`。已有任务用 `workflow activate --run ID` 选择。跨仓任务添加 `--affected-repo ID`，并完成逐仓一致性证据。新任务添加 `--category bugfix|feature|investigation|maintenance` 以积累可比指标；长日志用 `workflow log --digest SHA256` 按需读取。
<!-- local-ai-workflow:end -->
