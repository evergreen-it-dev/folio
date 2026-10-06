# Folio for onboarding

A way to run onboarding out of Folio: a space with the materials a newcomer needs, a form for the end of the first week, and an assistant that answers from those pages and tells you what the pages could not answer.

This folder is a description of the package and starter pages for the assistant. It is not a one-click template: Folio has no template gallery yet, so you create the space and paste the pages. The parts below all exist in Folio today.

Auth: none to set up for the built-in assistant (each person uses their own Folio account). External agents use a personal access token, see the other folders.

## What the package is

| Part | What it is in Folio |
|---|---|
| Materials | Ordinary pages in one space: welcome, a 30/60/90 plan, the product in one page, objections and answers, prices, the process, a glossary |
| Week-one check | A data table with a form on top of it: the newcomer answers on Friday, the manager reads the rows (and the table can be closed to the newcomer) |
| Process board | A whiteboard with the main process drawn out |
| Assistant rules | Pages in the space's `.agent` folder: how to answer, tone, glossary, escalation. Only space administrators see and edit them |
| Questions without an answer | A list the assistant fills when the pages do not contain the answer. Administrators read it at `/admin/assistant`, tab "Questions without an answer", and write the missing pages |

The loop that makes it worth doing: the newcomer does not just read, they show what the documents lack, and you add the page.

## Set it up

1. Create a space for it (**Create space**) and add the pages. Start from the structure above. A `_templates` folder in the space can hold your own starting pages.
2. Create a table "Week-one check answers" with the questions as columns, and add a form to it. Check the form on a test account before sending it to anyone.
3. In the `.agent` folder of the space add the pages from `agent-pages/` in this folder (adapt the wording): `How to answer`, `Tone`, `Escalation`. They apply to every run of the built-in assistant in this space.
4. Invite the newcomer with the editor role, or the viewer role if they only read.
5. Turn on the assistant: **Account, AI assistant**, and connect a Cursor key (a personal one, or an instance-wide key the operator sets with `CURSOR_API_KEY`). The newcomer opens **Ask AI** and asks.
6. As a manager open **Account, Assistant analytics** and read **Questions without an answer** each week.

What to know before you do: the built-in assistant sends the pages it works with to Cursor, and Cursor is the only provider for now. Without a subscription everything else in Folio works as usual.

## Without the built-in assistant

An external agent can answer from the same pages: connect Claude Code, Cursor, Open WebUI or another client with a **read** token of the newcomer's own user (see the other folders here). It works the same, with two differences:

- Folio does not record questions without an answer for an external agent. That tool exists only in the built-in assistant.
- The `.agent` pages are not visible to external agents. Put the rules in an ordinary page, `agent-pages/agent-playbook.md` in this folder, and say in the client's rule or system prompt: *Read the page "Agent playbook" first.* That also lets the team edit the rules in the browser.

## Try the shape on the public demo

<https://demo.foliowiki.online>, pick Sam on the sign-in screen. The demo is a handbook for Folio itself. Look at how a space is organised: the tree of pages, a table with a form, a whiteboard, and the `.agent` folder in the handbook space (Sam is an administrator there, so it is visible). The built-in assistant and API tokens are switched off on the demo, so you can read the setup but not ask the assistant. The login is shared and the data resets every 24 hours: do not enter personal data.

## Files

| File | What it is |
|---|---|
| `agent-pages/how-to-answer.md` | Starter for `.agent/How to answer`: short answers, a `Sources:` line with links |
| `agent-pages/tone.md` | Starter for `.agent/Tone` |
| `agent-pages/escalation.md` | Starter for `.agent/Escalation`: when to send the person to a human |
| `agent-pages/agent-playbook.md` | The same rules as one ordinary page, for external agents |
