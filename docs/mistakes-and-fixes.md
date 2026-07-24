# Mistakes and Fixes

Running log of non-obvious problems hit in this project and how they were fixed.

| Date | Problem | Fix |
|---|---|---|
| 2026-07-24 | Live SDK tool_result content can be a string; driver's whole-loop try/catch made one bad message kill the session; allowedTools doesn't restrict the tool set | string\|array content handling, per-message error containment, explicit tool restriction |
