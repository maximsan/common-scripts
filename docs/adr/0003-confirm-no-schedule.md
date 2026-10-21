# 3. A person picks and confirms instead of a scheduled task

**Context:** unattended deletion is the main risk, and a Cloud PC may not be running at a scheduled time ([Managing Windows 365 Flex](https://learn.microsoft.com/en-us/windows-365/enterprise/windows-365-flex-manage)).

**Decision:** in a terminal, a command prints the plan, then a person picks what to act on and types `yes`. Without a terminal, it only prints the plan. `--dry-run` only prints the plan in a terminal too. Only `--yes` acts without questions. `--due` only reminds.

**Consequences:** cleanup happens only when a person looks at it, or when they ask for no questions with `--yes`. Looking without acting takes `--dry-run`, or Esc at the pick list.
