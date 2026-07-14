'use strict';
// examples/demo.cjs — seed a backlog and watch the never-idle driver make decisions.
// Zero dependencies. It runs against a throwaway state file in your temp dir, so it never
// touches a real queue. Run it with:  node examples/demo.cjs

const os = require('os');
const path = require('path');
const fs = require('fs');

// Point the queue at a scratch file BEFORE loading the driver — it reads this env at load time.
const scratch = path.join(os.tmpdir(), 'relay-demo-state.json');
process.env.CONTINUOUS_LOOP_STATE_PATH = scratch;
try { fs.unlinkSync(scratch); } catch { /* first run */ }

const q = require('../lib/loop-queue.cjs');

async function main() {
  // A backlog of three heavy units. Each has a stable id (the dedupe key) and a human title.
  const backlog = [
    { id: 'refactor-auth', title: 'Refactor the auth module' },
    { id: 'add-tests', title: 'Add integration tests' },
    { id: 'write-docs', title: 'Write the API docs' },
  ];

  q.reset('demo-loop');
  q.start('demo-loop', 'ship the release', backlog);
  console.log(`seeded ${backlog.length} units into the queue\n`);

  let taskNo = 0;
  // The never-idle loop: ask the driver what to do, act on it, repeat — until it says stop.
  for (let step = 0; step < 10; step++) {
    // refill() runs ONLY when the queue is empty. Returning [] lets the loop end cleanly;
    // a real harness would fetch more work here (scan a backlog, ask a planner, etc.).
    const decision = await q.assertNextOrRefill(() => []);

    if (decision.action === 'launch') {
      const taskId = `t${++taskNo}`;
      console.log(`launch  → ${decision.unit.title}  (task ${taskId})`);
      q.launch(decision.unit, taskId);

      // A real harness spawns the work and returns; the task's COMPLETION is what wakes the
      // loop for the next unit. Here we complete immediately so the demo advances.
      q.complete(taskId, { ok: true });
      console.log('        · completion event → wake for the next unit');
    } else if (decision.action === 'wait') {
      // Reached only if a task is genuinely in flight (e.g. a crash mid-run resumed the state).
      console.log('wait    → a task is already in flight; its completion will wake the loop');
      break;
    } else {
      console.log('\nstop    → backlog empty even after refill; nothing left to do');
      break;
    }
  }

  try { fs.unlinkSync(scratch); } catch { /* best effort */ }
}

main().catch((err) => { console.error(err); process.exit(1); });
