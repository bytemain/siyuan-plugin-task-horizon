# AI Skill Architecture (Clean Room Draft)

## Purpose

This document proposes a clean-room skill architecture for Task Horizon's AI assistant.

Goals:

- Reuse the current `ai.js + aiBridge` foundation.
- Upgrade from "fixed JSON actions" to "plannable tool/skill calling".
- Keep read/write permissions explicit and controllable.
- Avoid any dependency on leaked or proprietary implementations.

Non-goals:

- Rebuilding the whole AI module from scratch.
- Introducing external MCP compatibility in phase 1.
- Letting the model execute arbitrary code.

## Current State

The current implementation already contains the core pieces needed for a skill system:

- `ai.js` builds context payloads and prompts the model with JSON-only schemas.
- `ai.js` parses structured outputs through `callMiniMaxJson(...)`.
- `ai.js` executes a small set of model-produced actions such as:
  - task patch application
  - task creation
  - schedule generation
  - summary generation
- `task.js` exposes a local bridge at `__tmNs.aiBridge` for controlled reads and writes.

Relevant code anchors:

- [ai.js](/d:/AI/trae/siyuan-plugin-task-horizon/ai.js:1888) `buildChatSystemPrompt()`
- [ai.js](/d:/AI/trae/siyuan-plugin-task-horizon/ai.js:1894) `applyChatTaskOperations(...)`
- [ai.js](/d:/AI/trae/siyuan-plugin-task-horizon/ai.js:1959) `applyChatCreateOperations(...)`
- [ai.js](/d:/AI/trae/siyuan-plugin-task-horizon/ai.js:3332) `runChatConversation(...)`
- [task.js](/d:/AI/trae/siyuan-plugin-task-horizon/task.js:48046) `__tmNs.aiBridge = { ... }`

In other words, the plugin already has:

- structured prompting
- controlled local execution
- persistent conversations
- context scoping

What it lacks is a general skill registry and a multi-step execution loop.

## Design Principles

1. Clean-room only
   Build from local needs and public concepts. Do not copy leaked code, prompts, protocols, or internal naming.

2. Read and write must be separated
   Read skills may run automatically. Write skills should require policy checks and often user confirmation.

3. Skills are explicit, typed, and inspectable
   Every skill should declare its name, description, input shape, and risk level.

4. The model plans, the runtime decides
   The model may propose skill calls. The runtime validates, limits, executes, and records them.

5. Conversation remains the top-level unit
   Skill calls are part of a conversation session, not an independent hidden subsystem.

## Target Architecture

The proposed stack:

1. `LLM Planner`
   Reads user request and current context, then proposes either:
   - a direct answer
   - a plan
   - one or more skill calls

2. `Skill Registry`
   A declarative map of all allowed skills.

3. `Skill Executor`
   Validates input, checks permission policy, executes against `aiBridge`, and normalizes results.

4. `Execution Loop`
   Repeats:
   - ask model what to do next
   - execute approved skill calls
   - feed results back to model
   - stop on final answer or max rounds

5. `Audit Log`
   Records plan, skill calls, results, failures, and final summary into conversation history.

## Core Types

### SkillSpec

Suggested shape:

```js
{
  name: "read_current_view_tasks",
  description: "Read visible tasks from the current view",
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

Recommended fields:

- `name`
- `description`
- `readOnly`
- `confirmPolicy`
- `inputSchema`
- `outputSchema` optional
- `run(input, ctx)`
- `isAvailable(ctx)` optional
- `timeoutMs` optional

### SkillCall

```js
{
  id: "call-1",
  skill: "get_task_detail",
  input: { taskId: "..." },
  reason: "Need task details before scheduling"
}
```

### SkillResult

```js
{
  id: "call-1",
  ok: true,
  skill: "get_task_detail",
  data: { ... },
  error: ""
}
```

### Turn Plan

The planner output for each round should be constrained to a simple JSON schema:

```js
{
  answer: "",
  plan: ["..."],
  skillCalls: [],
  done: false
}
```

This keeps the execution loop understandable and easy to debug.

## Suggested Skill Layers

### Layer 1: Read Skills

These are safe and should be implemented first.

- `read_current_view_tasks`
- `read_current_group_tasks`
- `read_document_snapshot`
- `read_task_snapshot`
- `search_tasks`
- `list_configured_docs`
- `read_summary_tasks_by_doc_ids`

These mostly map directly to existing `aiBridge` methods.

### Layer 2: Local Mutation Skills

These should be explicit and guarded.

- `update_task`
- `create_task`
- `create_subtask`
- `create_task_suggestion`
- `write_schedule_to_calendar`
- `update_schedule`
- `delete_schedule`

These already exist partially in current action-specific flows.

### Layer 3: Composite Skills

These are runtime-side helpers, not model magic.

- `plan_today_from_current_view`
- `summarize_range_for_doc`
- `split_goal_into_subtasks`

Composite skills can internally call other skills, but they should remain deterministic and logged.

## First Skill Set For Task Horizon

Recommended phase-1 registry:

1. `read_current_view_tasks`
2. `read_document_snapshot`
3. `read_task_snapshot`
4. `search_tasks`
5. `update_task`
6. `create_task`
7. `write_schedule_to_calendar`

Why this set:

- It covers the core "fetch data -> propose plan -> act" loop.
- It matches existing user expectations from chat, schedule, and summary flows.
- It minimizes architecture churn.

## Execution Loop

Suggested runtime loop:

1. Build session context.
2. Send planner prompt with:
   - user instruction
   - scope
   - available skills
   - prior skill results in this turn
3. Parse planner JSON.
4. If `done === true` and no skill calls remain, finalize.
5. Validate each skill call.
6. Run approved skills.
7. Append results to the turn log.
8. Repeat up to `maxRounds`.

Suggested limits:

- `maxRounds = 3` for chat
- `maxRounds = 5` for planning workflows
- `maxSkillCallsPerRound = 4`

If the loop reaches the limit:

- stop execution
- return a partial answer
- include what was completed and what remains

## Permission Model

Recommended policy values:

- `never`
- `ask`
- `always`

Meaning:

- `never`: safe read-only calls, no confirmation needed
- `ask`: user-visible confirmation required before mutation
- `always`: blocked unless explicitly enabled in settings

For Task Horizon, recommended defaults:

- read skills: `never`
- create/update task: `ask`
- delete or bulk mutation: `always`

## Conversation and Logging

Conversation storage should include a `toolLog` or `skillLog` array on each AI turn.

Suggested record:

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
      summary: "Returned 10 tasks"
    }
  ]
}
```

Benefits:

- easier debugging
- explainable AI behavior
- future support for retry and continue

## UI Recommendations

Add two small sections to the AI sidebar:

- `Execution Plan`
  Show the current plan in natural language.

- `Skill Trace`
  Show which skills were called, whether they succeeded, and what they returned at a high level.

Write actions should show a confirmation card such as:

- proposed action
- target task or document
- fields to change
- confirm / cancel buttons

This is much safer than allowing invisible background writes.

## Proposed File Layout

This can be implemented incrementally inside existing files first, then extracted if needed.

Phase 1 layout:

- `ai.js`
  - planner prompt builder
  - skill loop runner
  - skill log formatting
- `task.js`
  - existing `aiBridge`
  - additional bridge methods for missing capabilities

Phase 2 extraction:

- `src/ai/skill-registry.js`
- `src/ai/skill-executor.js`
- `src/ai/skill-schemas.js`
- `src/ai/skill-policies.js`

For the current repo, do not force extraction in phase 1 if it slows delivery.

## Integration Strategy With Current Code

### Step A: Keep current scenes unchanged

Keep `chat`, `smart`, `schedule`, and `summary` as the top-level user-facing modes.

### Step B: Replace only chat execution first

Current chat flow:

- prompt model
- parse `taskOperations` and `createOperations`
- execute fixed actions

Proposed chat flow:

- prompt model with available skills
- parse `skillCalls`
- run loop
- produce final answer

This isolates change to the most flexible scene without risking schedule/summary regressions.

### Step C: Convert fixed actions into skills

Map existing behavior:

- `taskOperations` -> `update_task`
- `createOperations` -> `create_task`
- schedule write -> `write_schedule_to_calendar`

This lets old logic survive as wrappers while the new registry becomes the source of truth.

## Example Planner Contract

Planner prompt should ask the model to return only:

```js
{
  "answer": "",
  "plan": [
    "Read current visible tasks",
    "Identify overdue tasks",
    "Suggest a three-step plan"
  ],
  "skillCalls": [
    {
      "id": "call-1",
      "skill": "read_current_view_tasks",
      "input": { "limit": 12 },
      "reason": "Need task list before planning"
    }
  ],
  "done": false
}
```

After results come back, the next round may either request more reads or finish with a final answer.

## Failure Handling

Every skill execution should normalize errors to a stable shape.

Runtime behavior:

- invalid skill name: reject and record
- invalid input: reject and record
- unavailable context: reject and record
- bridge failure: record detailed error

The planner should receive these failures in the next round so it can recover gracefully.

## Security Boundaries

Do not allow:

- arbitrary JS execution
- arbitrary network access from model-generated calls
- arbitrary file writes
- hidden batch mutations

All capabilities must remain behind named skills with runtime validation.

## Rollout Plan

### Phase 1

- Add `SkillSpec`
- Add local registry
- Add loop runner in chat scene
- Convert current update/create actions into skills
- Add skill trace UI

### Phase 2

- Reuse skill runner for schedule scene
- Add schedule-specific mutation skills
- Store `skillLog` in conversation history

### Phase 3

- Add composite skills
- Add settings for skill policy
- Evaluate future MCP-style adapter if still needed

## Minimal Pseudocode

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

## Recommendation

The best next move is not "build a universal agent". The best next move is:

1. convert current chat mutations into formal skills
2. add a small planner loop
3. expose execution trace in the sidebar

That gives Task Horizon a practical, explainable, and extensible skill system while keeping the current codebase stable.
