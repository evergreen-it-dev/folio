# Team skills: instructions for your agents as wiki pages

Your team has rules that agents should follow: how a release is cut, how incidents are written up, how a support reply is phrased. If those rules live in a prompt file in somebody's repository, every change has to be copied to every machine. In Folio they can live as ordinary wiki pages. People edit them in the browser, and every agent that is connected to Folio reads the current version the next time it needs it.

This page describes the setup and the two MCP tools that make it convenient, `list_skills` and `get_skill`.

## How it works

1. A skill is a page in a space, written for an agent: a goal, steps, examples, how to check the result.
2. The agent finds the page through the Folio MCP server and reads it.
3. Someone edits the page. The next time an agent reads it, it gets the new text. Nothing is deployed and nothing is reinstalled.

Rights and history are those of any page. An agent reads only what its token's owner may read, and a page that is closed to someone is invisible to that person's agents too. Every change is a Git commit in the space, so you can see who changed a skill and when, and go back to an earlier version.

## Write the skill page

Create a page and mark it as a skill: in the properties under the page title, add `skill` to `tags` and write a one-line `description`. The title of the page is the skill's name. An agent sets the same two with `set_page_properties`; `create_page` and `update_page` take the page's text only and do not keep front matter.

If you edit the wiki as files in Git, the same page looks like this:

```markdown
---
tags: [skill]
description: How we cut a release and write the release notes
---
# Release process

## Goal
A tagged release with notes that users can read, and no surprises on the day.

## Steps
1. Check that the main branch is green.
2. Bump the version and tag it.
3. Write the notes from the merged pull requests, grouped as Added, Changed, Fixed.
4. Post the link in the team channel.

## Example
Release 2.4: three Added items, one Fixed. The notes page is linked from the tag.

## Check the result
- The tag exists and CI for the tag is green.
- The notes page lists every merged pull request.
```

A few habits help:

- Write the description for the agent: it is what `list_skills` shows, and it decides whether the agent reads the skill.
- One skill, one job. A long page that covers three processes is read in full every time.
- End with a check the agent can run, not only a list of steps.

## Connect an agent

Create a personal access token in Folio (user menu, "API tokens") and register the server. For Claude Code:

```bash
claude mcp add folio --transport http https://<host>/mcp \
  --header "Authorization: Bearer folio_pat_…"
```

A `read` token is enough to use skills. Other clients, and OAuth for the clients that cannot send a header, are described in [Folio for AI agents: MCP and REST](MCP.md).

## How an agent finds a skill

Two tools do it:

- `list_skills` returns every skill the caller can read: `name`, `description`, the page `id`, the `space` and `path`, and `updatedAt`.
- `get_skill` takes a name or a page id from that list and returns the page text in `markdown`. If two skills have the same name, it answers with their ids and asks for one of them.

Folio's MCP instructions tell the agent to call `list_skills` before a task. Both tools only read, they follow the same access rules as `read_page`, and they are refused on a public site. A page that is closed to the caller does not appear in the list and `get_skill` answers "skill not found", the same as for a page that does not exist. The list is built on every call, so a page tagged a minute ago is already there.

Each skill is also offered as an MCP prompt, named after the title in lower case with dashes (`release-process`), with the description as its description. The prompt carries the skill text. Folio does not offer MCP resources. How a particular client lists or runs prompts differs, so rely on the two tools; the prompts are an extra.

### A local pointer skill

Some teams add a short local skill to the agent's own configuration that only points to the page, so the agent always knows where to look. It works with the general tools alone: `search_pages` (for example `tag:skill release`), then `read_page`. For Claude Code, a file `.claude/skills/release/SKILL.md` in the repository:

```markdown
---
name: release
description: Cut a release. Use when the task is about releasing or writing release notes.
---
Read the team's "Release process" page in Folio (`get_skill`, or `search_pages` and `read_page`) and follow it.
Do not work from memory: the page is the current version.
```

The pointer rarely changes. The page behind it changes as often as the team needs. Ready-made examples of such skills are in [`integrations/claude-code/skills/`](../integrations/claude-code/skills/folio-wiki/SKILL.md) and [`skills/`](../skills/README.md).

## Changing a skill

Edit the page in the browser like any other. The next `get_skill` (or `read_page`) returns the new text. A conversation that already read the old version keeps it until the agent reads the page again.

To see what changed, open the page history, or use `page_history` and `page_at_sha` from an agent. To go back, open the earlier version in the history and save its text as the current one.

## Safety

A skill is read by an agent as an instruction. Whoever can edit the page can change what every agent of the team does. Keep such pages in a space with a small, limited circle of editors, and give the others read access only. A space with a few trusted editors is enough; do not put skills in a space that the whole company can edit.

`get_skill` says so in its description: the text is the team's own, and the agent follows it for the task only as far as it fits what the user asked. It does not override the user, the tool rules or the agent's safety rules, and it does not widen the token's permissions. The `.agent` folder is not a place for skills for external agents: Folio hides it from everyone but the space admins.

Skills are not for secrets. Anyone who can read the page can read the skill, and so can their agents.
