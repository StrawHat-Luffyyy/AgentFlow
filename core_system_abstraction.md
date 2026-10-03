# AgentFlow — Core System Abstraction

> [!IMPORTANT]
> **Implementation Status Note:**
> The Execute → Remember → Control core abstraction defined in this document is implemented in the **TypeScript platform runtime** (`@agentflow/runtime`, `@agentflow/harness`, `@agentflow/db`, `apps/api`, `apps/worker`). The proposed Python prototype remains an uninstantiated conceptual research design.

## 1. What AgentFlow Is

**AgentFlow is an agent runtime.**

More specifically:

> AgentFlow is a model- and framework-agnostic runtime that executes, persists, monitors, and controls AI-agent workflows.

AgentFlow sits between an AI agent and the external systems the agent interacts with.

```text
                    AGENT
                      │
                      ▼
                 AGENTFLOW
                      │
              ┌───────┴───────┐
              ▼               ▼
           TOOLS             APIs
```

The agent remains responsible for reasoning and deciding what it wants to do. AgentFlow is responsible for making that execution reliable, observable, recoverable, and controllable.

---

## 2. Core System Abstraction

The core abstraction of AgentFlow consists of **three responsibilities**:

```text
                 AGENTFLOW
                     │
        ┌────────────┼────────────┐
        ▼            ▼            ▼
     EXECUTE       REMEMBER      CONTROL
        │            │            │
     run stuff     state       detect failure
     tools         checkpoints  recover
     APIs          history      intervene
```

These three responsibilities describe **what the runtime does**.

They do not, by themselves, define the final research contribution. The research contribution comes from the specific mechanisms implemented within these responsibilities and how those mechanisms are evaluated.

---

# 3. EXECUTE

## Purpose

**Execute** is responsible for running the agent's workflow and allowing the agent to interact with external capabilities.

At the simplest level:

```text
Agent
  │
  ▼
decides action
  │
  ▼
AgentFlow
  │
  ▼
Tool / API
  │
  ▼
result
  │
  ▼
Agent
```

Execution can include:

- LLM calls
- tool calls
- API calls
- workflow steps
- agent actions
- worker execution

The important distinction is that AgentFlow is not the agent's reasoning engine.

The agent decides:

> "I need to call this capability."

AgentFlow provides the runtime through which that action is executed.

## Potential Differentiation

The interesting question is not simply:

> Can AgentFlow execute tools?

Instead:

> **How does AgentFlow represent, expose, validate, and execute capabilities for agents?**

One proposed direction is an API capability abstraction such as:

```text
agentflow.api("OPENAPIKEY")
```

The intention is for AgentFlow to understand an API from its specification rather than requiring the developer to manually wire every endpoint.

For example, instead of manually implementing HTTP details, the runtime could expose a semantic capability such as:

```text
get_deployment_status(deployment_id)
```

The exact mechanism is a design/research question rather than a fixed part of the abstraction.

---

# 4. REMEMBER

## Purpose

**Remember** is responsible for maintaining the execution state of an agent workflow.

An agent may perform many steps:

```text
Step 1
  ↓
Step 2
  ↓
Step 3
  ↓
Step 4
  ↓
...
```

If execution fails at Step 4, the runtime should have enough durable information to understand where execution was and what happened previously.

Relevant state can include:

- current workflow state
- previous execution steps
- tool calls
- tool results
- checkpoints
- attempts
- execution history
- approval state
- recovery state

## Potential Differentiation

The interesting question is not simply:

> Can AgentFlow store state?

Instead:

> **What state should be persisted, when should it be checkpointed, and how should execution resume from that state?**

Possible research variables include:

- checkpoint frequency
- checkpoint granularity
- state representation
- checkpoint alignment
- recovery strategy

These are examples of possible mechanisms and parameters, not finalized decisions.

---

# 5. CONTROL

## Purpose

**Control** is responsible for monitoring execution and deciding what should happen when the workflow does not behave as expected.

Possible control actions include:

- continue
- retry
- back off
- replan
- rollback
- pause
- request human approval
- terminate

## Agent Reliability

One particularly important control problem is **non-progressing agent loops**.

An iterative tool-using agent can legitimately execute:

```text
think → tool → result → think → tool → result
```

The loop itself is not necessarily a failure.

The problem is when the agent continues executing without making meaningful progress.

For example:

```text
Tool A
  ↓
same / equivalent result
  ↓
Tool A
  ↓
same / equivalent result
  ↓
Tool A
  ↓
same / equivalent result
  ↓
...
```

AgentFlow can therefore ask:

> **Is the agent still making meaningful progress?**

This creates a potential research direction around:

- loop detection
- progress detection
- tool-call repetition
- result similarity
- state change
- error repetition
- intervention thresholds
- recovery policies

The important distinction is:

> **AgentFlow should not merely detect repeated execution. It should reason about whether execution is actually progressing.**

---

# 6. The Three Responsibilities Together

The three responsibilities form one runtime:

```text
                         AGENTFLOW
                             │
            ┌────────────────┼────────────────┐
            │                │                │
            ▼                ▼                ▼
         EXECUTE          REMEMBER          CONTROL
            │                │                │
       run actions        persist state     monitor execution
       tools              checkpoints       detect failures
       APIs               history           recover
       workflows                            intervene
            │                │                │
            └────────────────┼────────────────┘
                             │
                             ▼
                    DURABLE AGENT EXECUTION
```

They are interconnected.

For example, a failure during **Execute** may require **Remember** to provide a previous checkpoint, after which **Control** decides whether to retry, rollback, replan, pause, or stop.

Similarly, **Control** may detect a non-progressing loop by analyzing execution history stored through **Remember**.

---

# 7. What AgentFlow Is NOT

AgentFlow is not intended to replace the agent's reasoning model.

```text
             LLM / AGENT
          "What should I do?"
                   │
                   ▼
              AGENTFLOW
          "How should this
           execution proceed?"
                   │
                   ▼
             TOOL / API
```

The distinction is:

| Agent | AgentFlow |
|---|---|
| Reasons | Executes |
| Chooses actions | Manages actions |
| Produces tool calls | Runs tool calls |
| Attempts to solve the task | Makes execution durable |
| Generates plans | Enforces runtime behavior |
| Produces decisions | Tracks and controls execution |

The exact boundary can evolve as the implementation develops, but this is the core conceptual separation.

---

# 8. Where the Actual Differentiator Lives

The statement:

> "AgentFlow has Execute, Remember, and Control."

is a **system abstraction**, not by itself a research contribution.

Existing agent runtimes already provide various combinations of execution, state, durability, retries, tracing, human approval, and recovery.

Therefore, the key research/product question becomes:

> **What does AgentFlow do within these three responsibilities, and how does it do it differently?**

Examples:

### Execute

- How are API capabilities represented?
- How does the runtime determine which capability is appropriate?
- How are tool executions abstracted across different agent frameworks?

### Remember

- What execution state is persisted?
- When are checkpoints created?
- What information is required for reliable recovery?
- How does checkpoint strategy affect cost and recovery?

### Control

- How does AgentFlow detect failure?
- How does it distinguish legitimate iteration from a non-progressing loop?
- What evidence is used to classify a failure?
- What intervention strategy produces the best recovery?

These mechanisms are where experimental parameters, baselines, metrics, and research contributions can emerge.

---

# 9. Relationship to the Research

The literature review should therefore help answer:

1. What mechanisms already exist for **Execute**?
2. What mechanisms already exist for **Remember**?
3. What mechanisms already exist for **Control**?
4. What parameters have researchers actually varied?
5. What metrics have they measured?
6. What limitations or gaps remain?
7. Which specific mechanism is worth implementing and experimentally evaluating in AgentFlow?

This keeps the project grounded in existing work while leaving room for a focused contribution.

---

# 10. Current Conceptual Model

```text
                         ┌───────────────┐
                         │     AGENT     │
                         │               │
                         │  reasoning    │
                         │  planning     │
                         │  decisions    │
                         └───────┬───────┘
                                 │
                                 ▼
                    ┌────────────────────────┐
                    │       AGENTFLOW        │
                    │                        │
                    │   ┌──────┐ ┌────────┐ │
                    │   │EXECUTE│ │REMEMBER│ │
                    │   └──────┘ └────────┘ │
                    │                        │
                    │       ┌─────────┐      │
                    │       │ CONTROL │      │
                    │       └─────────┘      │
                    │                        │
                    └───────────┬────────────┘
                                │
                         ┌──────┴──────┐
                         ▼             ▼
                       TOOLS          APIs
```

**This is the core system abstraction of AgentFlow.**

The abstraction defines the runtime's fundamental responsibilities.

The **specific mechanisms inside Execute, Remember, and Control are the part that must be designed, justified through literature, implemented, and experimentally evaluated.**

---

## One-line definition

> **AgentFlow is a durable agent runtime built around three core responsibilities: Execute the agent's actions, Remember its execution state, and Control its behavior when execution fails or stops making progress.**
