# Skills

A **skill** is a reusable bundle of instructions (and optional scripts) that an agent can pull in on
demand. Skills live under `agents/<id>/skills/<skill-id>/`:

```
agents/researcher/skills/deep_research/
  SKILL.md            # frontmatter + instructions
  scripts/*.ts        # optional defineTool exports loaded with the skill
  references/*.md      # optional supporting material, inlined into the skill's injected content
```

## `SKILL.md` frontmatter

```markdown
---
name: Deep Research
description: Multi-source research with citation tracking.
---

When asked to research a topic:
1. Break it into sub-questions.
2. Search each with `web_search`.
3. Cross-check claims across at least two sources.
4. Return findings with citations.
```

Only flat `key: value` frontmatter is parsed (`name`, `description`). The body is the skill prompt.

## Two ways to invoke a skill

### Caller-driven

The caller names a skill for the whole run. The runner loads it, appends its body (and any
`references/*.md` content) to the system prompt, and registers its `scripts/` as extra tools —
before the LLM runs.

```ts
bread.run('researcher', { topic: 'sourdough' }, { skill: 'deep_research' })
// or over HTTP:
// POST /agents/researcher/run  { "input": {...}, "skill": "deep_research" }
```

### Agent-driven

When an agent has any skills on disk, the loader records their metadata (`_skills`) and the runner:

1. injects a short **summary** of available skills into the system prompt, and
2. exposes a built-in **`core_load_skill`** tool.

The agent decides when to call `core_load_skill({ skillId })`; the tool returns the skill's full
instructions, its script paths, and any `references/*.md` content as the tool result,
mid-conversation. The `core_load_skill` tool is only present when the agent actually has a
`skills/` directory.

## Trust model

Skill scripts run at **first-party trust**: a `scripts/*.ts` file loads into the bread process and
registers as a tool with the same capabilities as anything in `agents/<id>/tools/` — arbitrary
code, the process's filesystem/network reach, and (only) the credentials it declares. There is no
sandbox. The trust boundary is *who can write to the skill directory*: treat `skills/` folders as
source code, review them like source code, and never install a skill from a source you wouldn't
`bun add` from. Operator levers, in increasing strictness:

- **Permissions** — gate or block a skill's tools per agent with `skill:` selectors
  (`ask: ['skill:deep_research/*']`, `deny: ['skill:untrusted_skill/*']`) — see
  [agents.md](./agents.md#permissions).
- **Credentials** — a script only resolves the secret names its `defineTool` declares
  (`CREDENTIAL_NOT_DECLARED` otherwise); an undeclared script gets nothing.
- **Omission** — a skill that isn't in the agent's `skills/` directory doesn't exist; there is no
  dynamic skill installation at runtime.

## Notes

- Skill resolution needs the agent's directory, attached by the CLI loader as `_agentDir`. Running
  the runner in-process without the loader (e.g. unit tests) skips skill loading.
- Skill scripts are `defineTool` default exports, just like `tools/`.
