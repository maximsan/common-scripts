# Changelog

What changed in each version of the package that `npm pack` builds. The newest version comes first. Version numbers follow [semantic versioning](https://semver.org/): a new feature raises the middle number, a fix the last one.

## Unreleased

### Changed

- The question before acting asks `[y/N]`: type `y` or `yes` to go ahead. Enter alone, or any other answer, changes nothing.

## 2.2.0 (2026-10-23)

### Changed

- Result lines show `ok` in green and `FAIL` in red where the terminal shows colors. `skip` in `pull` and `keep` in a plan are dim. Output sent to a pipe or a file, and the log file, stay plain text.

## 2.1.0 (2026-10-23)

### Changed

- `pull` skips a repo whose branch has no upstream branch, such as a read-only clone, or whose HEAD is detached. The repo gets a `skip` line, the summary counts it, and it no longer makes the run fail.

## 2.0.0 (2026-10-21)

A major version, because commands that use `--apply`, `--build-days` or `--temp-days` stop working. Run them without `--apply` in a terminal, or replace `--apply --yes` with `--yes`; leave out the two `devclean` options.

### Changed

- In a terminal, `nmclean`, `install`, `devclean` and `token` no longer stop after the plan: they show the pick list and ask for "yes" right away. Esc or any answer other than "yes" changes nothing. Without a terminal they still only print the plan. See [decision 3](adr/0003-confirm-no-schedule.md).
- `--yes` alone now takes everything without questions, also without a terminal. It replaces `--apply --yes`.
- In the pick list, the `[x]` of a selected line is green where the terminal shows colors.

### Removed

- `--apply`. Using it stops the run with a message that names `--yes` instead.
- `devclean --build-days` and `--temp-days`. Build outputs and temp-folder entries always count as old after 7 days; `devclean --help` says so.

### Added

- `--dry-run` only prints the plan, also in a terminal.

### Fixed

- Esc at the "Type yes to continue" question cancels, as it does in the pick list. The question says so.

## 1.3.0 (2026-10-21)

### Added

- `nmclean --only` takes repo names or folder paths, so `--apply --yes` can act on some folders without the pick list. Only the named repos are measured. A name that matches no repo and no folder stops the run before anything changes.

## 1.2.0 (2026-10-21)

### Changed

- `nmclean`'s pick list shows each `node_modules` folder on its own line, so you can pick single folders inside a repo, such as only a repo's top-level `node_modules`.
- Enter in the pick list takes the line under the cursor when no line is selected.
- The name column of a plan grows to the longest name, so the sizes line up.
- The first word of the progress line is pink.

### Faster

- Measuring folder sizes reads all entries of a folder at once instead of one file at a time. On a Windows 365 Cloud PC, measuring 223,600 files took about 16 s instead of 42 s.
- The safety check right before each deletion reads only the folder listings, because it needs no sizes. `install`'s check of an existing `node_modules` does the same.

### Added

- `tools/nmclean-timing.mjs` times each step of an `nmclean` dry run. It is not part of the package.

## 1.1.0 (2026-10-21)

### Added

- Short command names: `pull`, `install` and `token`. The old names `gpall`, `nminstall` and `npmrctoken` still work.
- A pick list after `--apply`: choose which folders, repos, `.npmrc` files or `devclean` sections to act on. It uses the arrow keys where the terminal allows, and typed numbers elsewhere. `--yes` skips it and takes everything.
- A progress line while a command plans and runs, in color where the terminal shows colors. Where the terminal can't redraw a line, a plain line appears every few seconds.
- A dry run ends with the full command that applies it.
- Examples in `devclean --help`.

### Changed

- Plan headings no longer count repos.

## 1.0.0 (2026-10-21)

The first package: `gpall`, `nmclean`, `nminstall`, `devclean` and `npmrctoken`, behind the one `devkit` command. The [safety model](safety-model.md) describes what they refuse, check and keep.
