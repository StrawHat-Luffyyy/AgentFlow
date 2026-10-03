# AgentFlow — Primary Features

> [!IMPORTANT]
> **Implementation Status Note:**
> The primary feature abstractions described in this document are implemented in the **TypeScript platform runtime** (`@agentflow/runtime`, `@agentflow/harness`, `@agentflow/db`, `apps/api`, `apps/worker`). The separate Python package structure described below represents an early conceptual design and **was not implemented in code**.

## Purpose

This document defines the **primary functional features** of the AgentFlow prototype.

AgentFlow is an **agent runtime** built around three core responsibilities:

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

A fourth top-level package, `runtime/`, acts as the **glue layer** that composes these responsibilities and drives the execution loop.

The prototype is intended to be modular and configurable so that individual mechanisms can be replaced, tuned, recreated from existing approaches, and experimentally compared.

#### How this satisfies your modularity requirement

Each sub-feature above is really an **interface + swappable implementation** pair. Concretely, in Python that likely means: a `Protocol` or `ABC` per sub-feature (e.g. `ProgressDetector`), one or more concrete implementations, and the `Config` picks which implementation + params get injected into the `Loop` at construction time. Nothing in `runtime/` needs to know *which* `ProgressDetector` it got — just that it satisfies the interface.

---

# 1. `execute/` — Carrying Out Actions

The `execute/` package is responsible for carrying out actions requested by the agent.

## 1.1 Capability

**Responsibility:** Represent a single callable capability.

A capability contains:

- a name
- an input schema
- a callable operation
- a `run(args) -> result` interface

The capability interface is intended to remain stable while implementations can vary.

Possible implementations include:

- function-based tools
- HTTP APIs
- sub-workflows

### Swappable

- Capability implementations
- Capability type

The interface itself is treated as fixed.

---

## 1.2 CapabilityRegistry

**Responsibility:** Register and retrieve capabilities by name and validate their inputs before execution.

The registry provides a common mechanism for the runtime to discover available capabilities.

### Swappable / configurable

- Validation strictness
- Schema format

---

## 1.3 Invoker

**Responsibility:** Actually execute a capability.

The Invoker handles:

- synchronous execution
- asynchronous execution
- timeouts
- raw exception capture

The purpose is to keep execution mechanics separate from the capability definitions themselves.

### Swappable / configurable

- Timeout policy
- Sync vs async execution strategy

---

## 1.4 ResultNormalizer

**Responsibility:** Convert raw capability output into a standard `ExecutionResult`.

The normalized result can contain:

- status
- payload
- error
- metadata

This creates a common representation so that `remember/` and `control/` do not need to understand the internal implementation of every tool or API.

### Swappable / configurable

- Normalization rules for different capability types

---

## 1.5 APISpecAdapter — Optional / Later

**Responsibility:** Convert an OpenAPI specification into AgentFlow capabilities.

This corresponds to the proposed API capability abstraction:

```text
agentflow.api("OPENAPIKEY")
```

The goal is to allow AgentFlow to understand an API through its specification rather than requiring every endpoint to be manually wired.

This is **not required for v1** and should only be implemented if the project chooses to test this direction.

### Swappable

- API specification interpretation
- Capability-generation strategy

---

# 2. `remember/` — Maintaining Execution State

The `remember/` package is responsible for maintaining the state and history of an agent workflow.

It provides the information required to understand what has happened and, where applicable, recover execution.

---

## 2.1 StateStore

**Responsibility:** Persist and load the state of a workflow run.

Possible prototype backends include:

- in-memory dictionary
- JSON file
- SQLite

The backend can be selected depending on the experiment or prototype requirement.

### Swappable

- Storage backend

---

## 2.2 ExecutionHistory

**Responsibility:** Maintain an append-only record of execution steps.

A conceptual history entry is:

```text
{
    step,
    action,
    args,
    result,
    timestamp
}
```

The history provides the runtime with a record of what the agent has attempted and what happened.

### Swappable / configurable

- Log granularity
- Every-step logging vs summarized history

---

## 2.3 CheckpointPolicy

**Responsibility:** Decide when execution state should be checkpointed.

Possible policies include:

- checkpoint every step
- checkpoint every N steps
- checkpoint on specific events

Checkpointing is therefore separated from the storage mechanism itself.

### Experimentally relevant parameters

- Checkpoint frequency
- Checkpoint conditions

---

## 2.4 StateSnapshot

**Responsibility:** Represent the serialized state of a workflow at a particular point in execution.

A snapshot may contain information such as:

- current step index
- workflow variables
- pending approvals
- other state required for recovery

The exact snapshot schema is intentionally configurable.

### Swappable / configurable

- Snapshot representation
- Fields included in persisted state

---

## 2.5 Recovery

**Responsibility:** Reconstruct a workflow from its most recent usable checkpoint.

Possible recovery strategies include:

- resume from the exact checkpointed step
- re-derive state from execution history

The recovery strategy is intentionally treated as a replaceable mechanism.

### Swappable

- Recovery strategy

---

# 3. `control/` — Monitoring and Intervening

The `control/` package is responsible for observing execution, identifying problematic behavior, and determining what should happen next.

This is the richest area for the current research direction because it contains mechanisms for **non-progress detection and intervention**.

---

## 3.1 ProgressDetector

**Responsibility:** Determine whether recent execution is progressing or has become stuck.

Conceptually:

```text
Recent execution history
          │
          ▼
   ProgressDetector
          │
      ┌───┴───┐
      ▼       ▼
 progressing  stuck
```

Possible signals include:

- repeated tool calls
- similar results
- execution history
- state changes

Possible detection mechanisms include:

- exact matching
- string similarity
- embedding distance

### Experimentally relevant parameters

- Window size
- Similarity metric
- Similarity threshold

These are intentionally exposed as configurable mechanisms rather than being hard-coded into the runtime.

---

## 3.2 FailureClassifier

**Responsibility:** Distinguish different categories of execution failure.

Possible categories include:

- infrastructure failure
- timeout
- exception
- semantic failure
- invalid result
- non-progressing loop

The classifier provides a condition that can then be handled by an intervention policy.

### Swappable

- Classification rules
- Failure categories

---

## 3.3 InterventionPolicy

**Responsibility:** Map a detected condition to an action.

Possible actions include:

- continue
- retry
- backoff
- replan
- rollback
- pause
- terminate

This component is particularly important for reproducing different approaches.

A different policy can be selected to represent a different existing mechanism or experimental condition.

### Swappable

- Intervention strategy
- Mapping between conditions and actions

---

## 3.4 RetryBudget

**Responsibility:** Bound retries and backoff so that recovery mechanisms themselves cannot continue indefinitely.

Possible controls include:

- maximum attempts
- backoff behavior
- retry limits

### Experimentally relevant parameters

- Maximum retry attempts
- Backoff curve

---

## 3.5 ApprovalGate — Optional / Later

**Responsibility:** Pause execution while waiting for a human decision.

The pending approval state should be persisted through `remember/` so that the workflow can remain paused without losing its state.

This is **optional for v1**.

### Configurable

- Whether human approval is enabled
- Approval behavior

---

# 4. `runtime/` — The Glue Layer

The three core responsibilities need something that composes them and drives the overall execution process.

The `runtime/` package serves this role.

```text
                         RUNTIME
                            │
             ┌──────────────┼──────────────┐
             ▼              ▼              ▼
          EXECUTE        REMEMBER        CONTROL
             │              │              │
             └──────────────┼──────────────┘
                            │
                            ▼
                         LOOP
```

---

## 4.1 AgentAdapter

**Responsibility:** Provide a thin interface through which an agent or LLM-based system can interact with AgentFlow.

The purpose is to keep AgentFlow independent from a specific:

- LLM provider
- agent framework
- agent implementation

The adapter should allow an external agent to provide its next action decisions to the runtime.

### Swappable

- Agent implementation
- LLM/provider integration
- Agent framework integration

---

## 4.2 Loop

**Responsibility:** Drive the actual runtime cycle.

Conceptually:

```text
Execute
   ↓
Remember
   ↓
Control
   ↓
continue / recover / intervene
   ↓
Execute ...
```

The Loop composes the three core responsibilities.

It should not need to know the internal implementation of a particular detector, checkpoint policy, storage backend, or intervention strategy.

---

## 4.3 Config

**Responsibility:** Describe which mechanisms and parameters are active for a particular run.

Conceptually:

```text
Config
  │
  ├── execution mechanism
  ├── state mechanism
  ├── checkpoint policy
  ├── progress detector
  ├── intervention policy
  └── parameters
```

Configuration is what allows the same AgentFlow runtime to operate under different experimental conditions.

For example:

```text
Configuration A
    ProgressDetector = exact_match
    Window = 5
    Intervention = stop

Configuration B
    ProgressDetector = semantic_similarity
    Window = 10
    Threshold = 0.90
    Intervention = replan
```

The runtime remains the same while the mechanisms change.

---

## 4.4 ExperimentRunner — Optional / Later

**Responsibility:** Run the same task under multiple configurations and collect comparable metrics.

This is primarily an experimental convenience rather than a fundamental runtime responsibility.

It can be introduced later when the prototype is ready for systematic experimentation.

---

# 5. Overall Prototype Structure

The resulting conceptual structure is:

```text
agentflow/
│
├── execute/
│   ├── Capability
│   ├── CapabilityRegistry
│   ├── Invoker
│   ├── ResultNormalizer
│   └── APISpecAdapter       [optional]
│
├── remember/
│   ├── StateStore
│   ├── ExecutionHistory
│   ├── CheckpointPolicy
│   ├── StateSnapshot
│   └── Recovery
│
├── control/
│   ├── ProgressDetector
│   ├── FailureClassifier
│   ├── InterventionPolicy
│   ├── RetryBudget
│   └── ApprovalGate          [optional]
│
└── runtime/
    ├── AgentAdapter
    ├── Loop
    ├── Config
    └── ExperimentRunner      [optional]
```

This is a **functional breakdown**, not a claim that every item must be implemented immediately or that these are the final production components.

---

# 6. Modularity Philosophy

The prototype is intentionally designed around **replaceable mechanisms**.

The goal is not to create many abstractions simply for the sake of software architecture.

The goal is to make AgentFlow suitable for experimentation.

A mechanism should be replaceable when we want to:

- recreate an existing approach
- test a different implementation
- change an experimentally relevant parameter
- compare two mechanisms
- study a trade-off
- evaluate a proposed improvement

Conceptually:

```text
                    SAME AGENTFLOW
                         │
              ┌──────────┴──────────┐
              ▼                     ▼
        Configuration A       Configuration B
              │                     │
              ▼                     ▼
       Mechanism A             Mechanism B
              │                     │
              └──────────┬──────────┘
                         ▼
                     Compare
```

The prototype therefore functions as a **common experimental runtime** in which different mechanisms can be implemented and evaluated.

---

# 7. Relationship to Research

The primary purpose of this functional structure is to create a bridge between existing research and experimentation.

The intended relationship is:

```text
Existing research
        │
        ▼
Existing mechanism
        │
        ▼
AgentFlow component
        │
        ▼
Configurable implementation
        │
        ▼
Experimental condition
        │
        ▼
Measured result
```

This means AgentFlow does not need to invent an entirely new runtime architecture for every research approach.

Instead, a common runtime can provide the surrounding execution environment while individual mechanisms are swapped or modified.

---

# 8. What Is Fixed vs Swappable

### Relatively stable

- AgentFlow as an agent runtime
- Execute / Remember / Control abstraction
- Runtime as the glue layer
- Interfaces between major mechanisms
- Python prototype
- modular architecture
- configurable experimentation

### Intentionally variable

- capability implementations
- validation strategy
- invocation strategy
- result normalization
- state backend
- history granularity
- checkpoint policy
- snapshot representation
- recovery strategy
- progress detection mechanism
- detection parameters
- failure classification
- intervention policy
- retry policy
- agent adapter
- experimental configuration

The exact set of mechanisms and parameters can evolve as the literature review and experimentation reveal what is useful.

---

# 9. Core Design Principle

> **Build one modular AgentFlow runtime, then make the mechanisms inside it replaceable and configurable enough to recreate, modify, and experimentally compare different approaches to reliable agent execution.**

That is the central purpose of the prototype architecture.
