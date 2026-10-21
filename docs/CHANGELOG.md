# Changelog

What changed in each version of the package that `npm pack` builds. The newest version comes first. Version numbers follow [semantic versioning](https://semver.org/): a new feature raises the middle number, a fix the last one.

## Unreleased

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
