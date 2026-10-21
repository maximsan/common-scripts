# Safety model

These rules apply to `nmclean`, `nminstall`, `devclean` and `npmrctoken`. `gpall` only runs `git pull`.

## Where scripts refuse to run

The script stops with exit code 2 and changes nothing in:

- drive roots, the filesystem root and network (UNC) paths;
- your home folder;
- system and app-data folders, such as `ProgramFiles` and `LOCALAPPDATA` on Windows, or `/usr` and `~/.config` on macOS and Linux;
- on Windows, your OneDrive folders, because a deletion there also deletes the copy in the cloud.

The full list for each system is in the [platform rules](GLOSSARY.md): the `protected…` fields of `PLATFORM_RULES` in `lib/shared/platform.mjs`.

## What may be deleted in a repo

A folder is deleted only if all of these hold. Such a folder is a [repo folder](GLOSSARY.md).

- its name is exactly an allow-listed one (`node_modules`, `.next`, `.turbo`, `.parcel-cache`, `coverage`, `dist`, `build`);
- it sits next to a `package.json`;
- git ignores it (one exception, under [Before each deletion](#before-each-deletion));
- it contains no tracked file (checked case-insensitively);
- it contains no nested `.git`.

The search never enters dot-folders (`.venv`, `.yarn`, …), `node_modules` or nested repos.

Before `nminstall` installs a repo, it checks the `node_modules` folder at the repo root. It uses the same rules as for a [repo folder](GLOSSARY.md), because [`npm ci`](https://docs.npmjs.com/cli/v11/commands/npm-ci) deletes this folder and Yarn changes it. If the folder does not pass a check, the dry run shows it as kept, and `nminstall` does not install the repo.

`nminstall` does not check the `node_modules` folders of workspace packages. A workspace package is a package in a subfolder of the repo, with its own `package.json`. `npm ci` also deletes the contents of these folders.

## Links

Symlinks and junctions are removed as links. Their targets are never touched, and a folder reached through a link is never entered.

## Before each deletion

- every check runs again;
- the folder is renamed first, so a folder whose rename is refused (on Windows, usually a file in use) is skipped whole;
- a run interrupted after the rename leaves `<name>.devkit-deleting-<timestamp>` behind, which the next run finishes off.

The next run deletes such a leftover without the git-ignore check, because `.gitignore` no longer matches the new name. Every other check still applies, including "no tracked file".

On Windows, a read-only file is made writable first, because the attribute blocks deletion. macOS and Linux never change a file's permissions: there, the folder's permissions decide, and a changed mode would also reach every hard link of the file.

macOS and Linux allow renaming and deleting files that are in use. There, a folder in use is deleted, and programs that still have its files open keep reading them until they close them.

## Temp folder

This applies to `devclean` only. The temp folder must be where the system normally keeps it, or a subfolder. The places for each system are in the `tempHomes` field of `PLATFORM_RULES` in `lib/shared/platform.mjs`.

Only [temp entries](GLOSSARY.md) with nothing newer than the cutoff are deleted. Every rule is checked again right before each deletion. These temp entries are kept:

- links;
- entries that are neither a file nor a folder, such as sockets;
- folders holding a socket or another special file anywhere inside, since a running program may still use them;
- folders holding a nested git repo, as in repos;
- on macOS and Linux, entries owned by another user, since `/tmp` is shared.

## Token updates

This applies to `npmrctoken` only.

- only the text after `=` in the `_authToken=` line changes; every other byte of the file stays the same, including line endings;
- a file with more than one `_authToken=` line is left unchanged with a warning, since each registry probably needs its own token;
- an `.npmrc` that is a link is left alone, because it could point to your user-wide `~/.npmrc`;
- `.npmrc` files committed to git are updated too, so check `git status` before you commit;
- each file is read again right before writing, and read back afterwards to confirm the new token is there;
- the full token never appears in the output or the log.

## Process

An `--apply` run holds one lock shared by these scripts, so two of them never change files at the same time. A live run keeps refreshing the lock. Every action is logged to `%LOCALAPPDATA%\devkit\logs` on Windows and `~/.local/state/devkit/logs` elsewhere.

## Child processes

- they get no stdin and no inherited `GIT_*` variables, and credential prompts are disabled;
- git runs with fsmonitor disabled and no optional locks;
- npm/yarn run with the current folder excluded from the program search (on macOS and Linux, `PATH` keeps only absolute folders);
- on timeout, the command and every process it started are killed: with `taskkill` on Windows, and by listing them with `ps` elsewhere.

Background: [Node.js April 2024 security release (CVE-2024-27980)](https://nodejs.org/en/blog/vulnerability/april-2024-security-releases-2).

## Agent files are never deleted

`devclean` lists untracked files per repo (where agent scratch files show up) and the size of `~/.claude`. Claude Code deletes its own session data after `cleanupPeriodDays`. Use `claude project purge <path> --dry-run` for projects you no longer use. See [Claude Code: the .claude directory](https://code.claude.com/docs/en/claude-directory.md).
