# 1. Node.js scripts instead of PowerShell or bash

**Context:** the scripts must work in Git Bash, PowerShell and cmd on Windows and in macOS and Linux shells, and handle junctions, long paths and child processes predictably.

**Decision:** plain `.mjs` with JSDoc types checked by `// @ts-check`, using only built-in modules.

**Consequences:** the scripts need nothing installed, and tests run with `node --test`. TypeScript's type checking works without a build step. Junction handling relies on Node's `lstat`, so it needs the [one-time check on Windows](../../README.md#one-time-check-on-windows).
