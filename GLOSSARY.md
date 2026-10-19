# Glossary

**Repo folder** — a folder inside one of your repos that a script may delete, such as `node_modules` or `dist`. Temp-folder entries are not repo folders.

**Run context** — where a script run takes its surroundings from: the folder it runs in, the state and temp folders, where output goes, and how a confirmation is answered. A real run takes them from the process; tests pass their own.

**Platform rules** — how paths, protected folders, the temp folder and child environments work on one operating system. Real runs use the rules of the machine they run on; tests can use another system's rules.
