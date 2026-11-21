# Token report: real-1795251594349-5b5c57cc

- Provider: scripted (tool-research-scripted-v1); resolved models: tool-research-scripted-v1
- Token provenance: estimated token counts from the scripted provider, not billed usage
- Workload: tool-research (5 LLM calls in one agent step; E2/E2B crash after call 3)
- Context: full; cache scope: off (workload definition)
- Token counts are compared within this provider only; tokenizers differ across providers.

## Headline

- Under E0, AgentFlow A1 repeated 0 (95% CI 0–0) estimated tokens per run versus 0 (95% CI 0–0) for A1 without journal replay (tied with it), 0 (95% CI 0–0) for C1 (Temporal-style) (tied with it), 0 (95% CI 0–0) for C1-step (Temporal-style, agent loop as one activity) (tied with it), 0 (95% CI 0–0) for C2 (LangGraph-style) (tied with it), 0 (95% CI 0–0) for DBOS (tied with it) (n=5 per system; scripted provider; estimated token counts from the scripted provider, not billed usage).
- Under E1, AgentFlow A1 repeated 0 (95% CI 0–0) estimated tokens per run versus 0 (95% CI 0–0) for A1 without journal replay (tied with it), 0 (95% CI 0–0) for C1 (Temporal-style) (tied with it), 0 (95% CI 0–0) for C1-step (Temporal-style, agent loop as one activity) (tied with it), 0 (95% CI 0–0) for C2 (LangGraph-style) (tied with it), 0 (95% CI 0–0) for DBOS (tied with it) (n=5 per system; scripted provider; estimated token counts from the scripted provider, not billed usage).
- Under E2, AgentFlow A1 repeated 356 (95% CI 356–356) estimated tokens per run versus 947 (95% CI 947–947) for A1 without journal replay (fewer than it), 356 (95% CI 356–356) for C1 (Temporal-style) (tied with it), 947 (95% CI 947–947) for C1-step (Temporal-style, agent loop as one activity) (fewer than it), 947 (95% CI 947–947) for C2 (LangGraph-style) (fewer than it), 947 (95% CI 947–947) for DBOS (fewer than it) (n=5 per system; scripted provider; estimated token counts from the scripted provider, not billed usage).
- Under E2B, AgentFlow A1 repeated 0 (95% CI 0–0) estimated tokens per run versus 947 (95% CI 947–947) for A1 without journal replay (fewer than it), 0 (95% CI 0–0) for C1 (Temporal-style) (tied with it), 947 (95% CI 947–947) for C1-step (Temporal-style, agent loop as one activity) (fewer than it), 947 (95% CI 947–947) for C2 (LangGraph-style) (fewer than it), 947 (95% CI 947–947) for DBOS (fewer than it) (n=5 per system; scripted provider; estimated token counts from the scripted provider, not billed usage).

## Per system and scenario

| Scenario | System | n | Succeeded | Failure rate (Wilson 95%) | Tokens / successful run | Repeated tokens / run | Repeated calls | Duplicates | Committed re-exec | Recovery p50 / p95 ms | Journal replays (saved) | Cache hits (saved) | 429s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| E0 | A1 | 5 | 5 | 0% (0–43%) | 1851 (95% CI 1851–1851) | 0 (95% CI 0–0) | 0 | 0 | 0 | – / – | 0 (0) | 0 (0) | 0 |
| E0 | A1-nojournal | 5 | 5 | 0% (0–43%) | 1851 (95% CI 1851–1851) | 0 (95% CI 0–0) | 0 | 0 | 0 | – / – | 0 (0) | 0 (0) | 0 |
| E0 | C1 | 5 | 5 | 0% (0–43%) | 1851 (95% CI 1851–1851) | 0 (95% CI 0–0) | 0 | 0 | 0 | – / – | 0 (0) | 0 (0) | 0 |
| E0 | C1-step | 5 | 5 | 0% (0–43%) | 1851 (95% CI 1851–1851) | 0 (95% CI 0–0) | 0 | 0 | 0 | – / – | 0 (0) | 0 (0) | 0 |
| E0 | C2 | 5 | 5 | 0% (0–43%) | 1851 (95% CI 1851–1851) | 0 (95% CI 0–0) | 0 | 0 | 0 | – / – | 0 (0) | 0 (0) | 0 |
| E0 | DBOS | 5 | 5 | 0% (0–43%) | 1851 (95% CI 1851–1851) | 0 (95% CI 0–0) | 0 | 0 | 0 | – / – | 0 (0) | 0 (0) | 0 |
| E1 | A1 | 5 | 5 | 0% (0–43%) | 1851 (95% CI 1851–1851) | 0 (95% CI 0–0) | 0 | 0 | 0 | 2217 / 2299 | 0 (0) | 0 (0) | 0 |
| E1 | A1-nojournal | 5 | 5 | 0% (0–43%) | 1851 (95% CI 1851–1851) | 0 (95% CI 0–0) | 0 | 0 | 0 | 2290 / 2520 | 0 (0) | 0 (0) | 0 |
| E1 | C1 | 5 | 5 | 0% (0–43%) | 1851 (95% CI 1851–1851) | 0 (95% CI 0–0) | 0 | 0 | 0 | 2111 / 2437 | 0 (0) | 0 (0) | 0 |
| E1 | C1-step | 5 | 5 | 0% (0–43%) | 1851 (95% CI 1851–1851) | 0 (95% CI 0–0) | 0 | 0 | 0 | 2250 / 2686 | 0 (0) | 0 (0) | 0 |
| E1 | C2 | 5 | 5 | 0% (0–43%) | 1851 (95% CI 1851–1851) | 0 (95% CI 0–0) | 0 | 0 | 0 | 2393 / 2808 | 0 (0) | 0 (0) | 0 |
| E1 | DBOS | 5 | 5 | 0% (0–43%) | 1851 (95% CI 1851–1851) | 0 (95% CI 0–0) | 0 | 0 | 0 | 3608 / 4098 | 0 (0) | 0 (0) | 0 |
| E2 | A1 | 5 | 5 | 0% (0–43%) | 2207 (95% CI 2207–2207) | 356 (95% CI 356–356) | 5 | 0 | 0 | 2253 / 2553 | 10 (2955) | 0 (0) | 0 |
| E2 | A1-nojournal | 5 | 5 | 0% (0–43%) | 2798 (95% CI 2798–2798) | 947 (95% CI 947–947) | 15 | 0 | 0 | 2460 / 3100 | 0 (0) | 0 (0) | 0 |
| E2 | C1 | 5 | 5 | 0% (0–43%) | 2207 (95% CI 2207–2207) | 356 (95% CI 356–356) | 5 | 0 | 0 | 2468 / 3859 | 0 (0) | 0 (0) | 0 |
| E2 | C1-step | 5 | 5 | 0% (0–43%) | 2798 (95% CI 2798–2798) | 947 (95% CI 947–947) | 15 | 0 | 0 | 2140 / 4517 | 0 (0) | 0 (0) | 0 |
| E2 | C2 | 5 | 5 | 0% (0–43%) | 2798 (95% CI 2798–2798) | 947 (95% CI 947–947) | 15 | 0 | 0 | 2209 / 2684 | 0 (0) | 0 (0) | 0 |
| E2 | DBOS | 5 | 5 | 0% (0–43%) | 2798 (95% CI 2798–2798) | 947 (95% CI 947–947) | 15 | 0 | 0 | 3851 / 4109 | 0 (0) | 0 (0) | 0 |
| E2B | A1 | 5 | 5 | 0% (0–43%) | 1851 (95% CI 1851–1851) | 0 (95% CI 0–0) | 0 | 0 | 0 | 2133 / 2538 | 15 (4735) | 0 (0) | 0 |
| E2B | A1-nojournal | 5 | 5 | 0% (0–43%) | 2798 (95% CI 2798–2798) | 947 (95% CI 947–947) | 15 | 0 | 0 | 2137 / 2917 | 0 (0) | 0 (0) | 0 |
| E2B | C1 | 5 | 5 | 0% (0–43%) | 1851 (95% CI 1851–1851) | 0 (95% CI 0–0) | 0 | 0 | 0 | 1958 / 3128 | 0 (0) | 0 (0) | 0 |
| E2B | C1-step | 5 | 5 | 0% (0–43%) | 2798 (95% CI 2798–2798) | 947 (95% CI 947–947) | 15 | 0 | 0 | 2260 / 3373 | 0 (0) | 0 (0) | 0 |
| E2B | C2 | 5 | 5 | 0% (0–43%) | 2798 (95% CI 2798–2798) | 947 (95% CI 947–947) | 15 | 0 | 0 | 2751 / 3578 | 0 (0) | 0 (0) | 0 |
| E2B | DBOS | 5 | 5 | 0% (0–43%) | 2798 (95% CI 2798–2798) | 947 (95% CI 947–947) | 15 | 0 | 0 | 3729 / 4309 | 0 (0) | 0 (0) | 0 |

Repeated tokens are the tokens of LLM results beyond the first per LLM call (a step and its turn) in a run, i.e. work paid for again. Journal and cache savings are reported separately and are never subtracted from these figures.
