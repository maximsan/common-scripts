# 3. Dry run plus confirmation instead of a scheduled task

**Context:** unattended deletion is the main risk, and a Cloud PC may not be running at a scheduled time ([Managing Windows 365 Flex](https://learn.microsoft.com/en-us/windows-365/enterprise/windows-365-flex-manage)).

**Decision:** dry run by default, then `--apply` and a typed `yes`; `--due` only reminds.

**Consequences:** cleanup happens only when you look at it.
