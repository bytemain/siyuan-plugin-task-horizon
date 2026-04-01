# AI Skill 架构草图（Clean Room 中文版）

## 目的

这份文档是给 Task Horizon 的 AI 助手准备的一版干净实现方案，也就是：

- 基于你当前仓库已有代码继续演进
- 不参考、不复制任何泄露源码
- 从“固定几个 AI 动作”升级到“可扩展的 skill 调用体系”

这份方案重点解决的是：

- AI 不只是回复文本，而是能自己按步骤获取数据
- AI 能列计划、查任务、再决定下一步
- AI 的读写权限是可控的，不会变成黑盒乱改数据

不打算在第一阶段做的事：

- 不重写整套 AI 模块
- 不一开始就做外部 MCP 通用协议
- 不让模型执行任意代码

## 现状判断

你现在的实现，其实已经具备了 skill 系统的基础。

当前链路大致是：

1. `ai.js` 负责收集上下文、拼 prompt、请求模型
2. 模型返回固定 JSON
3. `ai.js` 解析 JSON 后执行有限动作
4. `task.js` 里的 `aiBridge` 提供受控的数据读写能力

相关代码入口：

- [ai.js](/d:/AI/trae/siyuan-plugin-task-horizon/ai.js:1888) `buildChatSystemPrompt()`
- [ai.js](/d:/AI/trae/siyuan-plugin-task-horizon/ai.js:1894) `applyChatTaskOperations(...)`
- [ai.js](/d:/AI/trae/siyuan-plugin-task-horizon/ai.js:1959) `applyChatCreateOperations(...)`
- [ai.js](/d:/AI/trae/siyuan-plugin-task-horizon/ai.js:3332) `runChatConversation(...)`
- [task.js](/d:/AI/trae/siyuan-plugin-task-horizon/task.js:48046) `__tmNs.aiBridge = { ... }`

换句话说，你现在已经有：

- 结构化 prompting
- 受控执行层
- 会话持久化
- 上下文范围控制

你现在缺的不是“从 0 做 AI”，而是两层：

- 一个正式的 `skill registry`
- 一个多轮的 `plan -> call skill -> observe -> continue` 执行循环

## 设计原则

### 1. 必须是 clean-room

只基于你自己的需求、当前仓库结构、公开通用概念来设计。  
不要复制泄露代码、内部 prompt、私有协议或命名。

### 2. 读写必须分离

- 读 skill 可以自动执行
- 写 skill 必须做权限校验
- 高风险写操作最好要求确认

### 3. skill 必须是显式、可审计的

每个 skill 都要明确声明：

- 名称
- 说明
- 输入参数
- 是否只读
- 是否需要确认

### 4. 模型负责提议，运行时负责裁决

模型只能说“我想调用哪些 skill”。  
真正是否允许执行、怎么执行、失败怎么处理，都由本地运行时控制。

### 5. 会话仍然是顶层单位

skill 调用不是隐形后台行为，而是 AI 会话的一部分。  
后续日志、回放、继续执行，都会依附在 conversation 上。

## 目标架构

建议分成 5 层：

### 1. LLM Planner

负责理解用户意图，然后输出：

- 直接回答
- 执行计划
- 一组 skill 调用请求

### 2. Skill Registry

统一登记系统里允许 AI 调用的 skill。

### 3. Skill Executor

负责：

- 校验 skill 名称是否合法
- 校验输入参数是否合法
- 校验权限策略
- 调用 `aiBridge`
- 统一返回结果

### 4. Execution Loop

多轮执行循环：

1. 问模型下一步做什么
2. 执行允许的 skill
3. 把结果喂回模型
4. 再判断要不要继续

### 5. Audit Log

把计划、skill 调用、结果、失败信息都写进会话记录。

## 核心数据结构

### SkillSpec

建议结构：

```js
{
  name: "read_current_view_tasks",
  description: "读取当前视图中的任务",
  readOnly: true,
  confirmPolicy: "never",
  inputSchema: {
    type: "object",
    properties: {
      limit: { type: "number", minimum: 1, maximum: 100 }
    }
  },
  run: async (input, ctx) => {}
}
```

推荐字段：

- `name`
- `description`
- `readOnly`
- `confirmPolicy`
- `inputSchema`
- `outputSchema` 可选
- `run(input, ctx)`
- `isAvailable(ctx)` 可选
- `timeoutMs` 可选

### SkillCall

```js
{
  id: "call-1",
  skill: "read_task_snapshot",
  input: { taskId: "xxx" },
  reason: "先读取任务详情，再决定是否排期"
}
```

### SkillResult

```js
{
  id: "call-1",
  ok: true,
  skill: "read_task_snapshot",
  data: { ... },
  error: ""
}
```

### TurnPlan

建议每一轮只让模型返回一个简单 JSON：

```js
{
  answer: "",
  plan: ["先读取当前任务", "检查截止日期", "给出计划建议"],
  skillCalls: [],
  done: false
}
```

这样最容易调试，也最容易控风险。

## skill 分层建议

### 第一层：读技能

这一层最安全，建议优先做。

- `read_current_view_tasks`
- `read_current_group_tasks`
- `read_document_snapshot`
- `read_task_snapshot`
- `search_tasks`
- `list_configured_docs`
- `read_summary_tasks_by_doc_ids`

这层大部分可以直接映射你已有的 `aiBridge` 方法。

### 第二层：本地写技能

这一层必须受控。

- `update_task`
- `create_task`
- `create_subtask`
- `create_task_suggestion`
- `write_schedule_to_calendar`
- `update_schedule`
- `delete_schedule`

这类能力你现在已经零散存在，只是还没统一成 skill。

### 第三层：组合技能

这一层不是让模型“更神”，而是运行时封装一些高频工作流。

- `plan_today_from_current_view`
- `summarize_range_for_doc`
- `split_goal_into_subtasks`

组合 skill 内部可以调用别的 skill，但它本身应该保持可记录、可解释。

## 第一阶段最值得做的 skill

建议先做这 7 个：

1. `read_current_view_tasks`
2. `read_document_snapshot`
3. `read_task_snapshot`
4. `search_tasks`
5. `update_task`
6. `create_task`
7. `write_schedule_to_calendar`

原因：

- 已经覆盖“取数据 -> 出计划 -> 执行”的主链路
- 跟你现在聊天、排期、摘要场景自然衔接
- 不需要大改架构

## 执行循环设计

建议流程：

1. 构建当前 session 上下文
2. 把以下内容发给模型：
   - 用户指令
   - 当前 scope
   - 可用 skill 列表
   - 本轮之前已经拿到的 skill 结果
3. 解析模型返回的 planner JSON
4. 如果 `done === true` 且没有 skill 要调用，就结束
5. 校验 skillCalls
6. 执行允许的 skill
7. 把结果记入 turn log
8. 继续下一轮，直到完成或达到轮数上限

建议限制：

- 聊天场景 `maxRounds = 3`
- 规划类场景 `maxRounds = 5`
- 每轮最多 `4` 个 skill call

如果达到上限还没做完：

- 停止继续调用
- 返回当前已经完成的内容
- 明确告诉用户剩余步骤

## 权限模型

推荐使用这 3 种策略值：

- `never`
- `ask`
- `always`

含义：

- `never`：安全只读，不需要确认
- `ask`：需要在 UI 里确认后执行
- `always`：默认禁止，只有显式开启才允许

对 Task Horizon 的建议默认值：

- 读 skill：`never`
- 普通新建/修改任务：`ask`
- 删除、批量修改：`always`

## 会话与日志

建议在 AI 对话记录里增加 `skillLog` 或 `toolLog`。

例如：

```js
{
  round: 1,
  calls: [
    {
      id: "call-1",
      skill: "read_current_view_tasks",
      input: { limit: 10 },
      ok: true,
      durationMs: 42,
      summary: "返回了 10 条任务"
    }
  ]
}
```

这样做的价值很高：

- 方便排错
- 方便做“为什么 AI 这么回答”的解释
- 后续容易做“继续执行”“重试失败步骤”

## UI 建议

建议在 AI 侧栏里新增两块区域：

### 1. 执行计划

展示 AI 当前准备做什么，比如：

- 读取当前视图任务
- 检查逾期项
- 生成今天的执行计划

### 2. Skill 轨迹

展示：

- 调用了哪个 skill
- 是否成功
- 返回了什么摘要

对于写操作，建议弹一个确认卡片，显示：

- 将修改什么
- 修改哪个任务/文档
- 具体字段变化
- 确认 / 取消

这样比“后台直接偷偷改”安全很多。

## 文件落点建议

第一阶段不建议为了“结构漂亮”就过度拆文件。  
先在现有文件里完成最小闭环更实际。

### 第一阶段

- `ai.js`
  - planner prompt 构建
  - skill loop 执行
  - skill log 格式化
- `task.js`
  - 继续复用 `aiBridge`
  - 补齐缺失 bridge 能力

### 第二阶段再抽离

后面如果稳定了，再拆出去：

- `src/ai/skill-registry.js`
- `src/ai/skill-executor.js`
- `src/ai/skill-schemas.js`
- `src/ai/skill-policies.js`

## 与当前代码的衔接方式

### Step A：先保留现有场景

继续保留：

- `chat`
- `smart`
- `schedule`
- `summary`

这些还是用户看到的顶层入口。

### Step B：优先改 chat

当前 `chat` 的模式是：

- 发 prompt
- 得到 `taskOperations` / `createOperations`
- 执行固定动作

建议先把它改成：

- 发 planner prompt
- 得到 `skillCalls`
- 执行 skill loop
- 最后产出回答

这样改动最集中，风险最小。

### Step C：把旧动作包装成 skill

把已有能力映射成 skill：

- `taskOperations` -> `update_task`
- `createOperations` -> `create_task`
- 日程写入 -> `write_schedule_to_calendar`

这样旧逻辑还能继续复用，但新的 skill registry 会变成统一入口。

## 推荐的 planner 输出协议

建议让模型只输出这种格式：

```js
{
  "answer": "",
  "plan": [
    "先读取当前视图任务",
    "找出今天最关键的三项",
    "给出执行顺序"
  ],
  "skillCalls": [
    {
      "id": "call-1",
      "skill": "read_current_view_tasks",
      "input": { "limit": 12 },
      "reason": "需要先拿到任务列表"
    }
  ],
  "done": false
}
```

下一轮再根据 skill 结果继续判断。

## 失败处理

每个 skill 的执行结果都应该归一化。

运行时需要处理：

- skill 名称不存在
- 输入参数不合法
- 当前上下文不允许该 skill
- bridge 调用失败

这些错误都不该直接让系统崩掉，而应该记录下来，再把错误摘要喂回模型，让它决定是否换条路。

## 安全边界

必须明确禁止：

- 模型生成任意 JS 执行
- 模型直接发任意网络请求
- 模型直接写任意文件
- 模型执行隐形批量修改

所有能力都必须挂在命名好的 skill 上，并经过运行时校验。

## 分阶段落地计划

### Phase 1

- 定义 `SkillSpec`
- 建立本地 skill registry
- 在 chat 场景加入最小 skill loop
- 把现有 update/create 包装成 skill
- 在侧栏展示 skill trace

### Phase 2

- 在 schedule 场景复用同一套执行器
- 增加日程相关写 skill
- 会话持久化 skillLog

### Phase 3

- 增加组合 skill
- 增加 skill 权限设置
- 再评估是否需要 MCP 风格适配层

## 最小伪代码

```js
async function runSkillLoop(session, userInstruction) {
  const turnState = { logs: [], results: [] };

  for (let round = 1; round <= 3; round += 1) {
    const plannerResult = await callPlanner(session, userInstruction, turnState);
    const calls = validateSkillCalls(plannerResult.skillCalls, session);

    if (!calls.length && plannerResult.done) {
      return finalizeTurn(plannerResult, turnState);
    }

    const results = await executeSkillCalls(calls, session);
    turnState.logs.push({ round, calls: results });
    turnState.results = results;
  }

  return buildRoundLimitResponse(turnState);
}
```

## 最后建议

现在最值得做的，不是一下子追求“万能 agent”，而是先完成这个最小闭环：

1. 把现有 chat 里的修改/创建动作正式 skill 化
2. 加一个小型 planner loop
3. 把执行轨迹展示在 AI 侧栏里

这样你就能得到一个：

- 能自己取数据
- 能自己列步骤
- 能按权限执行
- 用户能看懂过程

的 AI skill 系统，而且对现有代码冲击最小。
