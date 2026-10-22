# Working in this repo

- **Windows 365 Cloud PC first.** The scripts are built for a Windows 365 Cloud PC: the user has no administrator rights and probably no Developer Mode. Weigh every finding and check against that machine first, then macOS and Linux.
- **Docs live in `docs/`.** Terms: [docs/GLOSSARY.md](docs/GLOSSARY.md). What the scripts refuse, check and keep: [docs/safety-model.md](docs/safety-model.md). Decisions: [docs/adr/](docs/adr/), one file per decision. Changes per version: [docs/CHANGELOG.md](docs/CHANGELOG.md); a change a user notices gets a line there. The README is the owner's cheat sheet: commands, setup and links.
- **Done means `npm run check` passes.** The house rules, each with its reason, are in `eslint.config.mjs`.

## Commands

```bash
npm install                                    # once: the lint and type-check tools (they need Node 22+)
npm run check                                  # lint, then type check, then all tests
npm run format                                 # auto-fix lint findings
node --test tests/shared/run.test.mjs          # one test file; needs no install
node --test --test-name-pattern="planAndRun" tests/shared/run.test.mjs   # one test by name
node index.mjs nmclean --dry-run               # run a command from a repos folder, plan only
```

The scripts themselves run on Node 18 and need no install. The Linux test run in Docker is in the README, under Checks.

## Architecture

- **One entry point.** `index.mjs` looks the command up in `lib/commands/index.mjs` (`COMMANDS`, where a command may also have aliases) and starts it through `runCommand` (`lib/shared/cli.mjs`). `runCommand` builds the [run context](docs/GLOSSARY.md) from the process and sets the exit code. A thrown `SafetyError` becomes exit code 2.
- **Commands import the shared code only through `lib/shared/index.mjs`.** `pull` (`lib/commands/gpall.mjs`) is the exception: it imports nothing from `lib/shared/` and takes its folder, output and progress line from the run context, so a few helpers are copied there on purpose. Comments that say "keep in sync with gpall.mjs" mark them.
- **Every command except pull has the same shape:**
  1. `parseArgs`;
  2. `findReposHere`, which refuses an unsafe current folder before it finds repos;
  3. build plan sections, whose items are `{ name, skip, run }`;
  4. `planAndRun`, which prints the plan, stops there when the run only looks ([decision 3](docs/adr/0003-confirm-no-schedule.md)), lets the person pick groups of items (`PlanItem.group`), asks for confirmation, takes the lock, runs the items in a pool and writes the log.
- **Check and remove come in pairs.** The plan calls the check (`checkRepoFolder`, `checkTempEntry`). Each item's `run` calls the matching remove (`removeRepoFolder`, `removeTempEntry`), which runs the check again first. Every folder deletion ends in `safeRemoveTree` (`lib/shared/remove.mjs`): it renames the folder, validates it again, then deletes. Never delete through any other path.
- **Operating-system differences live only in `PLATFORM_RULES`** (`lib/shared/platform.mjs`, [decision 5](docs/adr/0005-platform-rules-table.md)). How to add one is written above the `PlatformRules` type.
- **Tests mirror `lib/`** in `tests/commands/` and `tests/shared/`. `tests/setup.mjs`:
  - `testContext` calls a command's `main` in the same process, with its own run context;
  - `runCli` starts `index.mjs` as a separate process;
  - `tempWorkspace` gives each test file its own folder.

  `tests/utils.mjs` builds repos, files and links. Folder links are junctions, so the tests need no extra rights on Windows.
