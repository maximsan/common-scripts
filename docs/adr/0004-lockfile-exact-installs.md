# 4. Lockfile-exact installs only

**Context:** a bulk install must not change lockfiles or pick a package manager by guesswork.

**Decision:** `npm ci` / `--frozen-lockfile` / `--immutable`; ambiguous repos are skipped with the reason.

**Consequences:** repos without a lockfile need one manual install first.

Sources: [npm ci](https://docs.npmjs.com/cli/v11/commands/npm-ci), [Yarn 1 install](https://classic.yarnpkg.com/en/docs/cli/install), [Yarn install (2+)](https://yarnpkg.com/cli/install).
