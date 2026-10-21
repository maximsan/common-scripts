# 5. One table for every difference between operating systems

**Context:** Windows, macOS and Linux differ in path rules, protected folders, the temp folder, child processes and file ownership. Checks spread across the code were hard to find, and the Windows ones could only be tested on Windows.

**Decision:** every difference is a field in `PLATFORM_RULES` in `lib/shared/platform.mjs`, with one entry per system (see [platform rules](../GLOSSARY.md)). Code reads the rules and never the system itself; lint rejects `process.platform` everywhere else. How to add a system or a new difference is written above the table.

**Consequences:** the Windows path rules are tested on macOS and Linux. A new difference between systems costs a field in every entry.
