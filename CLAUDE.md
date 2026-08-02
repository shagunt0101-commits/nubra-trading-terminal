# Nubra Trading Terminal

## NotebookLM Brain (project memory)

Notebook: "Nubra Trading Terminal — Project Brain"
ID: `6abd10b2-c00a-4fbf-99ee-fabb2b64a1ef`
Sources: `.notebooklm-brain/*.md` (7 docs: overview, broker layer, runbook, architecture, scalper engine, backtest/PGHO optimizer, AI/frontend).

**Before starting work**, check current state:
```
notebooklm ask "What's the current state, recent sweep results, and open issues?" --notebook 6abd10b2-c00a-4fbf-99ee-fabb2b64a1ef
```
Note: `--notebook <id>` is required for parallel-safety; a bare `ask` uses the stored context.

**After a session touches the repo**, record it:
```
notebooklm note create "Session summary" -t "<date>: <one-line scope>" --notebook 6abd10b2-c00a-4fbf-99ee-fabb2b64a1ef
```
(Or with body: `notebooklm note create --content "Changed X in optimizer, fixed Y" -t "Title" --notebook <id>`.)

Keep `.notebooklm-brain/*.md` docs in sync with code changes so the brain stays current — source docs are the ground truth the brain answers from.
