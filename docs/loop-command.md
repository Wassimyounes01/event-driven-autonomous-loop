# The loop command

A tiny command that starts (or resumes) a never-idle work session. It's the human-facing on-ramp
to the [self-wake pattern](./self-wake-pattern.md): you name a goal and a backlog, and the agent
works through it — waking itself on each completion — until the queue is empty.

This is written as a **Claude Code slash command**, but the shape ports to any agent harness that
can run a script and read/continue on a stop hook.

## What it does

1. Seeds the durable queue with your backlog (`start(loop, goal, units)`).
2. Launches the first unit.
3. Lets the [stop-hook](../hooks/stop-hook.cjs) continue the session on each stop while work remains.
4. Stops cleanly when the backlog is empty and a refill produces nothing new.

## Defining it as a slash command

Create `.claude/commands/loop.md` in your project:

```markdown
---
description: Start a never-idle work loop over a backlog until it's empty.
---

You are running a continuous work loop. Do this every turn:

1. Run `node lib/loop-queue.cjs` to see the current queue status.
2. If a task is in flight, finish it, then `node -e "require('./lib/loop-queue.cjs').complete('<taskId>', {ok:true})"`.
3. Ask the queue what to do next. If it returns `launch`, start that unit now.
4. Only stop when the queue reports `idle: true`.

Backlog to seed (skip if the queue is already running): $ARGUMENTS
```

Invoke it with a goal and the loop picks up from there:

```
/loop refactor the payments module, add tests, and update the docs
```

## Wiring the stop-hook

Register the reference hook so a stop becomes "continue if there's work." In
`.claude/settings.json` (or your harness's hook config):

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [ { "type": "command", "command": "node hooks/stop-hook.cjs" } ] }
    ]
  }
}
```

When the agent tries to stop, the hook checks the queue. Empty → the stop is allowed. Work
remaining → it returns a `reason` that tells the agent which unit to pick up next, and the session
continues. The `stop_hook_active` guard in the hook prevents an endless loop if the queue can never
drain.

## Registering the safety-net wake

The stop-hook covers the normal path (the agent finishes a turn and would otherwise stop). Pair it
with a long-interval scheduled wake as a hang-catcher, in case a turn ends without triggering the
hook. Any scheduler works — a cron entry, a harness timer, or your agent runtime's built-in
scheduled-wake — as long as it periodically runs one queue step:

```bash
# every ~90s: advance the loop if a completion was missed (a no-op if a task is in flight)
node -e "require('./lib/loop-queue.cjs').assertNextOrRefill(()=>[]).then(d=>console.log(d.action))"
```

Keep the interval long (see [self-wake-pattern.md](./self-wake-pattern.md#why-90-seconds-not-2)) —
it's a backstop, not the driver.

## Seeding a backlog from code

You don't need the slash command to use Event-Driven Autonomous Loop — the queue is a plain library:

```js
const q = require('./lib/loop-queue.cjs');

q.start('nightly', 'clear the backlog', [
  { id: 'lint',  title: 'Fix all lint errors' },
  { id: 'tests', title: 'Raise coverage to 80%' },
  { id: 'docs',  title: 'Document the public API' },
]);

// then, each time a task finishes:
q.complete(taskId, { ok: true });
const { action, unit } = await q.assertNextOrRefill(() => []);
if (action === 'launch') startWork(unit);   // completion-wake
```

See [`examples/demo.cjs`](../examples/demo.cjs) for a runnable end-to-end walk-through.
