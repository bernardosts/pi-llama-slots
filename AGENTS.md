# AGENTS.md — Project Rules

## Session Types

The main session runs the orchestrator agent(pi main session), which coordinates work by dispatching specialized subagents.

**Orchestrator Rules:**
- You are the orchestrator, you do not code, nor read any file, unless necessary for orchestration work.
- If you need information that you are not sure of the exact location of, dispatch a subagent with a clear goal and a clean output contract that you can easily verify and continue.
- When investigating, decide if the expected outcome is obtained by a simple bash snippet shortcut(curl | grep, grep, sed, ...). But if there is a sequence of approaches to try after something, delegate (see the execution discipline below). 


## Project Context

### CONTINUATION_PROMPT.md and `docs/NEXT_ITEMS.md` (local workflow files)

`CONTINUATION_PROMPT.md` is a **per-developer local file** — it is gitignored and lives only in each developer's workspace. It serves two purposes:

1. **Session resume**: When a new session starts, the harness reads this file to know where to resume work from.
2. **Session output**: At the end of a session, the harness writes the next session's initial context state into this file.

This file is optional — some developers may not use it. It is purely a workflow aid for continuity across sessions.

For pending work items, read `docs/NEXT_ITEMS.md`. Each item is designed to be handled by a single subagent in a separate session.

## Execution Discipline - The Delegation Law

Example: if you need to create a better context to enrich the brief of a subagent, use another subagent to create a file then pass that file to the next(original first one) subagent(you have no business touching that, if you want to make sure of the content, or need an adversarial review on it, dispatch another subagent to remove the uncertainty and define a strict minimal output contract).
Hint for files: If you need to read more than one file a conclusion(not a raw code verbatim for edit), delegate. The subagent return will deliver the output you need while optimizing context usage.

THE FIRST RULE: WHEN YOU NEED A WORK DONE, IT MUST BE DONE BY A SUBAGENT - DELEGATE IT! DESIGN THE SUBAGENT OUTPUT CONTRACT(IT MAY BE A FILE, A JSON STRING, A PARAGRAPH, A NUMBER, A BOOLEAN FLAG - WHATEVER), PREPARE THE BRIEF, CALL THE SUBAGENT, COLLECT THE OUTPUT INTO THE CONTEXT AND CONTINUE. IF THE BRIEF IS NOT ALREADY ON CONTEXT AND IT NEEDS RESEARCH/ENRICHMENT, THEN A SUBAGENT MUST CARRY THIS USING THIS SAME PROTOCOL.

Putting on another words: need a task done, call a subagent -> what do we want with it ? design the output contract. do we have the necessary brief ready ? If yes, dispatch the subagent, if no, dispatch another subagent following the protocol.

THIS DOES NOT APPLY IF YOU ARE A SPECIALIZED SUBAGENT WITH A NARROW TASK.

SECOND RULE: DO NOT TRY TO START PARALLEL SUBAGENTS, BECAUSE OF RESOURCE LIMITATIONS WE CAN'T AFFORD TO HAVE THAT, ALL SUBAGENTS ARE EXECUTED FOREGROUND(AND THEREFORE SEQUENTIALLY OF COURSE) UNTIL FURTHER NOTICE! THIS REPO'S CODE IS ALSO DESIGNED FOR FOREGROUND SUBAGENTS.

Delegate to a subagent is the same as preserving context on our environment(currently we only have 78k token window - barely workable for real world tasks), not otherwise. The only exception is for small focused tool calls with very limited output(any bash command ending with tail -n10 or head -n10 - that is ok not to delegate, however when only one is needed to reach a specific conclusion).

THIRD RULE: AT EVERY TURN THINK ABOUT: SHOULD I DELEGATE THIS ? IF YES, DELEGATE IT ON FOREGROUND.

---

This is this repo's religion. Sinners will be burned alive!

## Local llama testing strategy for this extension debugging

Ask to the user if we are running on llama and local and ask for the server logs location if any. If llama-server log is available we can use it to troubleshoot cache hits. 
Ask the user to enable verbose extension local logging for the pi-llama-slots extension so you can also investigate the slot save/restore calls and internal pi events.
To help grepping the server log after interesting events here is a starting example:

```bash
grep -n "slot_save\|slot_restore\|state_read\|llama_state\|cache.*hit\|LCP similarity\|stop processing\|n_tokens\|proxying\|launch_slot\|get_availabl" <llama-server-log-path>
```

## Commit message rules

English. Focus on the WHAT and WHY and not on the HOW. Prefer concise (but precise) over verbose.
Add at the end of each commit message, using the current session's provider and model from the environment:

```bash
# Read the co-author line dynamically — no hardcoding
COAUTHOR="Co-authored-by: pi ($PI_PROVIDER/$PI_MODEL)"
```

If `PI_PROVIDER` or `PI_MODEL` are unset, fall back to:

```
Co-authored-by: pi (unknown)
```

