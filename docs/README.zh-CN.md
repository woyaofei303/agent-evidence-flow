# Agent Evidence Flow（中文说明）

这是一个运行在本地的 AI 编码工作流引擎。它把一次开发任务拆成可恢复、可审计的步骤，并要求用测试、源码复核和结构化事件证明每次关键迁移。

本项目是 [Eysion/local-ai-workflow](https://github.com/Eysion/local-ai-workflow) 的修改版，保留原许可与署名，仅限非商业用途。来源和修改说明见 [NOTICE.md](../NOTICE.md)。

## 使用

正常用法是让 AI Agent 驱动工作流：先把工作流安装到目标仓库，再用 Claude Code 或其他会读取 `AGENTS.md` 的 AI 编程工具打开该仓库，直接用自然语言描述任务。安装器生成的 `AGENTS.md` 和可选 Claude Hook 会提示 Agent 何时检查状态、创建 Run、收集证据和验证改动。

```bash
./install.sh /absolute/path/to/your-repository --apply
cd /absolute/path/to/your-repository
# 在这里启动 AI 编程工具，然后描述任务
```

对于脚本、调试或不会读取仓库规则的 Agent，也可以直接调用底层 CLI：

```bash
workflow start \
  --task-id example-task \
  --request "update the login page" \
  --changed-file src/pages/LoginPage.vue

workflow status
workflow explain
workflow timeline
```

`start` 会创建一个本地 Run，之后按规划、实现、验证推进；只有明确请求时才会进入本地提交流程。开发者通常只需给 AI Agent 提示词，直接 CLI 属于高级用法。运行 `workflow --help` 可查看上下文索引、沉淀、Shadow Mode 和恢复命令。

## 设计原理

### 有限状态机管理生命周期

Run 默认沿着 `intake → planning → implementation → verification → sediment → complete` 推进。契约检查、有限循环和本地提交分支只在对应信号出现时加入。节点必须满足前置依赖和证据门槛才能继续。

### DAG 表达依赖

工作流节点用有向无环图描述。DAG 把执行顺序与模型解耦，允许按任务需要插入 `openspec-contract`、`loop-execution` 和质量评估，同时保持确定性。

### 证据优先

模型自述不能代替证据。事件、测试结果、源码复核、沉淀记录和质量评估共同决定状态迁移。默认状态输出只显示摘要，完整 evidence 保存在本地 Run Event。

### 可恢复和最小副作用

JSON Event Store 追加事件；Lease/Heartbeat 处理进程中断；Commit Journal 用于提交后对账。提交需要 Start 时的 `--commit` 和执行时的 `commit --yes` 两次明确授权。工作流不执行 push、PR、发布或生产写入。

### 清晰的仓库边界

安装器支持单仓和父级 Workspace。它只写目标父级，不修改子仓库，不隐式删除旧入口；`tooling/ai-workflow/` 是唯一分发源。

为兼容已有安装，CLI 命令 `workflow`、安装目录 `tooling/ai-workflow/` 和受管理区块标记保持原值。

## 实现原理

- **CLI**：`cli/workflow.mjs` 解析命令，调用 `src/` 用例；npm/pnpm 安装后通过 `workflow` 二进制运行。
- **策略**：`planning-policy`、`quality-policy` 和 `evidence-routing-policy` 将任务信号转换为可测试决策，不依赖旧评分、权重或 ceremony tier。
- **执行**：`node-state-machine`、`workflow-graph` 和 runner 计算节点状态并写入事件。
- **证据**：`json-event-store` 保存不可变事件；`context-index` 提供本地文本索引，但最终仍需 `rg`、源码阅读和验证。
- **仓库适配**：Git/Sediment adapter、单 Writer 锁、精确暂存和 Commit Journal 限制写入范围并支持恢复。
- **安装探测**：`scripts/install.mjs` 读取项目清单，识别 Node、Python、Rust、Go、Flutter、Gradle、Maven 等技术栈，生成 `.workflow/config.yaml` 和验证命令；未知项目退回 `git diff --check`。

## 状态流程

```text
intake
  → [openspec-contract]
  → planning → implementation
  → [loop-execution]
  → verification → sediment
  → [atomic-commit-plan → shadow-decision → commit]
  → complete
```

## 常用命令

```bash
workflow start --task-id task-id --request "request summary" --changed-file src/example.ts
workflow status [--verbose]
workflow explain
workflow timeline
workflow resume
workflow index
workflow search --query "payment token" --limit 10
```

## 提交证据、修复和重验

`start` 会自动推进到 intake；`evidence` 返回已填入任务上下文的 JSON 和待填字段。`resolve` 接受部分 JSON，成功后自动推进，无需反复创建中间文件或手动调用 resume。

```bash
workflow evidence --node intake
workflow resolve --node intake --json '{"acceptanceCriteria":["预期行为通过验收"]}'
workflow resolve --node planning --json '{"steps":["实现并验证改动"]}'
workflow resolve --node implementation --json '{"summary":"完成约定改动"}'
workflow sediment
```

复杂输入可使用 `--evidence-stdin` 或原有 `--evidence-file`。质量评估须逐项覆盖 intake 验收条件，并引用最新成功验证事件；所有验收通过才能 accepted。新 Run 仅在声明 `SOLUTION_TRADEOFF` 时要求候选比较，默认不生成候选或评分字段。旧评分字段可以读入，但不参与接受判断；旧 Run 已记录的候选要求仍保留。

```bash
workflow retry --node verification --reason "修复失败断言"
workflow loop check --change "调整本轮实现"
```

retry 回到 implementation，使验证、质量、沉淀和提交规划等下游证据失效；成功后才可继续编辑。`resume` 自动对账中断中的提交；已经标为失败的提交用 `workflow reconcile --run ID` 对账。未完成的提交组保持 waiting，只有显式执行 `commit --yes` 才继续。Loop 从首次检查开始计时，每轮真实执行验证，并在轮次、时间或连续无进展预算达到限制时停止；重试不会重置预算。成功检查在受控文件和验证环境未变化时可用于 verification；无进展判断会清理常见耗时和时间戳噪声。

## 验证覆盖配置

优先复用已有 `check`/`verify` 综合脚本；没有时组合已有 lint、typecheck、test、build。单命令旧配置仍可用，也可以配置多个检查：

```yaml
verification:
  checks:
    - id: lint
      file: pnpm
      args: [lint]
      coverage: static
      timeoutMs: 120000
    - id: test
      file: pnpm
      args: [test]
      coverage: behavior
      timeoutMs: 120000
```

`coverage` 可为 behavior、build、static。仅将真正执行任务行为的检查声明为 behavior；未知自定义命令需人工核对后分类。`git diff --check`、lint、build 单独不能启用无人值守或自动迭代。引擎保留每个检查的结果；若验证修改了受控文件，需要检查改动并再次验证。

## 工具预算与历史经验

`tool execute` 执行已登记只读能力；MCP 通过项目配置的固定桥接程序接入，该程序从 stdin 接收 JSON，并向 stdout 输出结果。引擎不允许调用时替换命令或工作目录。

```yaml
evidenceRoutingPolicy:
  version: 1
  localFirst: true
  maxMcpCallsPerRun: 2
  maxCostUnitsPerRun: 4
  cache: true
  capabilities:
    - id: docs-read
      kind: mcp
      access: read
      enabled: true
      costUnits: 2
      timeoutMs: 30000
      command:
        file: node
        args: [scripts/read-docs.mjs]
```

示例中的桥接脚本需项目自行提供。预算在实际执行前预留，失败或中断的调用仍计费；缓存返回已记录结果，任务文件或输入变化时失效，缓存最长保留 30 秒，也可用 `--fresh` 跳过；本地上下文检索每次复核候选新鲜度。`tool record` 仅用于导入外部调用的审计数据，不能拦截外部 Agent 绕过引擎自行发起的调用。

```bash
workflow tool execute --capability docs-read --json '{"query":"目标接口"}' --local-evidence "已检查本地实现，缺少上游接口说明"
workflow sediment recommend
workflow sediment reuse --json '{"path":"docs/workflow-sediment/previous-task.md","adopted":true,"helped":true}'
workflow intervention --reason "人工澄清验收条件"
workflow metrics
```

新任务会检索相关沉淀；采纳时检查记录指纹，防止登记过期经验。metrics 汇总任务耗时、首次验证通过率、重验次数、修复次数、显式记录的人工介入和经验复用。未执行验证时首次通过率为 null；没有完成任务时平均完成耗时为 null。耗时包含等待，不代表模型计算时间，也不推算没有基线的“节省时间”。

## 任务选择、跨仓与验证边界

新任务不能隐式覆盖未结束的活动 Run。确认切换后，在 `start` 添加 `--replace-active 旧ID`；恢复已有任务用 `workflow activate --run 目标ID --replace-active 旧ID`。切换只更新选择，不会删除旧任务。活动节点执行中不允许切换；并行开发仍应使用独立 worktree。

`--changed-file` 必须是精确文件路径，目录和任一级符号链接均不允许。验证指纹包含受控文件、Git HEAD、未提交文件内容和常见依赖清单/锁文件。非 Git 项目使用支持的源码文件扫描及常见清单；状态文件和当前生成的沉淀文件被排除。外部服务、被忽略的依赖和环境变量变化仍需主动重验。质量接受、沉淀、提交和完成都会检查验证是否过期。

工作区任务通过重复 `--affected-repo ID` 声明影响范围，ID 必须存在于配置中，当前仓库会自动加入。跨仓信号统一开启 OpenSpec 和一致性检查；必须先写入非空 proposal，再提交契约证据。一致性证据需逐仓给出验证引用和兼容结论，通过后才能沉淀或提交。生产故障 intake 在实现前要求症状、影响、回滚路径和验证限制。用 `workflow evidence --node bugfix-intake` 或 `--node cross-repo-parity` 获取模板。

## 日志与实际提效基线

超过 2 KiB 的 stdout/stderr 独立保存在状态目录的 `logs/` 下；事件只保留预览和内容指纹，同内容日志复用。默认状态输出显示摘要。完整日志可分段读取：

```bash
workflow log --digest 日志SHA256 --offset 0 --limit 16000
workflow status --verbose
```

新任务可使用 `--category bugfix`、`feature`、`investigation` 或 `maintenance`。建议先积累一批范围可比的小修复、跨文件功能和故障排查任务，再导出基线：

```bash
workflow metrics > .workflow/state/baseline.json
workflow metrics --baseline .workflow/state/baseline.json
```

指标按类别汇总耗时、首次通过率和 CLI 调用量。`executionMs` 是引擎节点运行时间，`waitingMs` 包含外部 Agent 工作、人工等待与调度间隔，不等同于纯人工等待或模型计算时间。CLI 自动计数不含 help、hook、repos 和 metrics，也不包含直接调用运行时 API；人工介入仍通过 `workflow intervention --reason "原因"` 记录。旧记录缺失的调用和介入不能补算。

基线对比只报告观测差值；先后快照可能包含重复任务，不代表独立实验组。仓库不附带虚构的业务提效数据，实际节省幅度需要积累真实任务后评估。

## 目录约定

`.workflow/config.yaml` 保存项目配置；`.workflow/state/` 保存 Run、Lease、Shadow 报告和 Commit Journal，默认被 Git 忽略。

## 许可证

原项目提供的 [LICENSE](../LICENSE) 已原样保留，包括非商业限制和版权署名。该文件不允许销售、付费服务、广告投放以及用于商业产品或商业工作流。文件虽标注 PolyForm Noncommercial 1.0.0，正文却是简述，因此包元数据直接指向实际许可文件，不宣称它是标准许可全文。来源和修改记录见 [NOTICE.md](../NOTICE.md)。
