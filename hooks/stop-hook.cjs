'use strict';
// hooks/stop-hook.cjs — a REFERENCE Stop hook that turns "the agent is about to stop" into
// "check the backlog and continue if there's work left." Adapt it to your own agent harness.
//
// It is written for a Claude Code Stop hook, which receives a JSON event on stdin and can:
//   • allow the stop  → print nothing and exit 0
//   • continue instead → print {"decision":"block","reason":"<what to do next>"} and exit 0
// The `reason` is handed back to the agent, so it keeps working instead of going idle.
//
// The only decision this hook makes is: "is the queue empty?" — everything else (spawning the
// work, generating the queue) belongs to your harness and the loop-queue driver. This hook never
// throws: any error falls through to "allow stop", so a bug here can never wedge a session.

const q = require('../lib/loop-queue.cjs');

function readStdin() {
  try {
    return require('fs').readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function main() {
  let event = {};
  try {
    const raw = readStdin().trim();
    if (raw) event = JSON.parse(raw);
  } catch {
    event = {};
  }

  // Loop guard: if this stop is ITSELF the result of a previous continue, let it stop.
  // Without this, a persistently non-empty queue could continue forever.
  if (event.stop_hook_active) {
    process.exit(0);
    return;
  }

  let s;
  try {
    s = q.status();
  } catch {
    process.exit(0); // can't read the queue → allow the stop
    return;
  }

  // Work remaining = something in flight OR something queued. Idle means: stop cleanly.
  const hasWork = !!s.in_flight || s.queue_len > 0;
  if (!hasWork) {
    process.exit(0);
    return;
  }

  const next = s.in_flight?.unit?.title || s.next?.title || 'the next queued task';
  const reason =
    `Backlog is not empty (${s.queue_len} queued` +
    (s.in_flight ? ', 1 in flight' : '') +
    `). Continue the loop: pick up "${next}" instead of stopping.`;

  process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
  process.exit(0);
}

main();
