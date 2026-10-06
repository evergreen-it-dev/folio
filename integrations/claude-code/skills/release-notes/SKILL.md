---
name: release-notes
description: "Compare the repository with the team's Folio wiki and write release notes: read git log since the last tag, read the Roadmap table, create or update a Release notes page and add what the roadmap table is missing. Use when asked for release notes or to sync the wiki with the code."
disable-model-invocation: true
---

# Release notes from the code and the wiki

Use the `folio-wiki` skill for how to work with Folio. This skill is the recipe.

1. Find the last tag: `git describe --tags --abbrev=0`. Read `git log <tag>..HEAD --oneline`. If there are no tags, ask which commit to start from.
2. In Folio, find the release process page (`search_pages`) and read it. Report which checklist items are still open.
3. Find the roadmap table (`folio_table_list`), read its schema, then query the rows whose status is Done or In review.
4. Compare. Commits with no matching roadmap row are what the table is missing. Do not add rows on your own. List them and ask, unless the user already said to add them.
5. Create a page called "Release notes" where the user said (usually under Engineering), or update the existing one. Keep it short: what shipped, grouped by area, each item linked to its roadmap row or page where one exists.
6. Re-read the page, then answer with the link, the open checklist items and the commits that have no roadmap row.

Do not paste commit hashes of private branches or secrets from the diff into the wiki.
