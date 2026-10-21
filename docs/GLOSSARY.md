# Glossary

**Repo folder** — a folder inside one of your repos that a script may delete, such as `node_modules` or `dist`. Temp-folder entries are not repo folders.

**Run context** — where a script run takes its surroundings from: the folder it runs in, the state and temp folders, where output and the progress line go, whether a person can answer, and how a confirmation and a pick from a list are answered. A real run takes them from the process; tests pass their own.

**Platform rules** — how paths, protected folders, the temp folder and child environments work on one operating system. Real runs use the rules of the machine they run on; tests can use another system's rules.

**Temp entry** — a file or folder directly inside the temp folder. `devclean` keeps or deletes it as a whole, judged by the newest file in it. Example: `/tmp/build-123/` is a temp entry, `/tmp/build-123/cache.bin` is not.
