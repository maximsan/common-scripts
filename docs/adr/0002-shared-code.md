# 2. Shared code plus small commands

**Context:** several scripts need the same safety checks and run flow; copying them risks the copies drifting apart.

**Decision:** the shared code owns every check and the plan/confirm/run flow; each script only plans its items. Commands reach it through one interface, `lib/shared/index.mjs`; the implementation is split by area in `lib/shared/`. `index.mjs` is the only file that is started: the `devkit` command that `npm link` installs points to it.

**Consequences:** safety fixes land in one place, but the commands must be copied together with `index.mjs` and all of `lib/`.
