# Contributing to RELAY

Thanks for your interest! RELAY is MIT-licensed and built to be forked, extended, and
dropped into your own stack.

## Ground rules

- **Keep it portable.** No hardcoded paths, no personal accounts, no vendor lock-in. Config comes
  from `.env` (see `.env.example`).
- **Zero-secret CI.** The test suite must pass with no API keys — that's what the echo/dry-run path
  is for. Don't add a test that needs a live credential.
- **Small, focused PRs.** One change per PR, with a one-line "why."

## Dev loop

```bash
npm install
npm test            # runs the zero-dependency path — no keys needed
npm run check       # syntax-checks every source file
```

## Reporting issues

Open an issue with: what you ran, what you expected, what happened (with the exact output).

## Code of conduct

Be kind. Assume good faith. We're all here to build.
