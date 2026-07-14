# The self-wake pattern

RELAY keeps an autonomous agent working across a long backlog **without idling between tasks**.
The whole design rests on one inversion:

> **Completion is the cadence. A timer is only a safety net.**

Most "keep working" loops are timer-driven: do a task, sleep N seconds, wake, do the next.
That wastes the gap (the agent sits idle until the timer fires) and couples throughput to a
guessed interval. RELAY flips it — the *finishing* of one task is the event that launches the
next, so there is no gap to waste.

## The two signals

| Signal | Role | When it fires |
|---|---|---|
| **Completion event** | The driver. Launches the next unit. | The instant the in-flight task finishes. |
| **Scheduled wake** | The safety net. Catches a missed completion. | On a long interval (~90s), only if nothing else woke the loop. |

If completion events always arrived, you would never need the timer. But processes crash,
callbacks get dropped, and a wake can be missed — so a long-interval scheduled wake re-checks the
queue as a backstop. It is deliberately *slow*: it exists to catch a hang, not to pace the work.

## The loop, in three states

`lib/loop-queue.cjs` exposes one core call, `assertNextOrRefill(refill)`, which returns exactly
one of three actions — and crucially, **there is no fourth "idle" state**:

```
                 ┌──────────────────────────────┐
   launch  ◄─────┤  assertNextOrRefill(refill)  │
     │           └──────────────────────────────┘
     ▼                    ▲            │
  run task                │            ├─► wait   (a task is in flight; its
     │                    │            │           completion will wake you)
     └── completion ──────┘            │
         event                         └─► stop   (queue empty even after a
                                                   refill; nothing left to do)
```

- **launch** — the queue has a unit; start it now.
- **wait** — a task is already in flight; do nothing, its completion is the wake.
- **stop** — the queue is empty *and* `refill()` produced no new work; end cleanly.

Because the only terminal state is `stop` (reached only after an explicit empty refill), the loop
can never quietly "sit on a timer." Idle is impossible by construction.

## Wiring it to an agent harness

1. **On task completion**, call `complete(taskId, result)` then run one `assertNextOrRefill` step.
   If it returns `launch`, start the next unit immediately — that is the completion-wake.
2. **On stop**, run [`hooks/stop-hook.cjs`](../hooks/stop-hook.cjs): if the backlog isn't empty it
   tells the agent to continue instead of stopping (see [loop-command.md](./loop-command.md)).
3. **Register a scheduled wake** on a long interval (~90 seconds is plenty) whose only job is to
   run one `assertNextOrRefill` step. If a completion event was missed, this recovers the loop; if
   nothing was missed, it finds a task already in flight and returns `wait` — a cheap no-op.

## Why ~90 seconds, not 2

The scheduled wake is a *hang-catcher*, so its interval should be long enough that it almost never
fires before a real completion event does. A very short interval turns the safety net back into the
driver — the exact timer-paced idling this pattern removes. Pick an interval comfortably longer
than a typical task; anything in the 60–300s range works. Clamp it to a sane floor so a
misconfiguration can't busy-loop.

## What "durable" buys you

The queue lives on disk (`CONTINUOUS_LOOP_STATE_PATH`, default
`./memory/continuous-loop-state.json`) with at most one task in flight. If the process dies mid-task,
the next wake reads the persisted state, sees the in-flight record, and resumes cleanly rather than
double-launching or losing the backlog.
