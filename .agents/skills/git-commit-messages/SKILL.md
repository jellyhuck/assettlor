---
name: git-commit-messages
description: Draft, validate, revise, or review Git commit messages using capitalized imperative subjects, a 50-character subject target (72 maximum), and bodies wrapped at 72 characters. Use whenever writing a commit message, including as part of an authorized commit workflow.
---

# Git Commit Messages

## Determine the content

Base the message on the changes intended for this commit and the context
provided by the user. When working in a repository, inspect Git status and
the relevant diff. For a staged commit, use the staged diff; do not describe
unstaged changes as part of that commit. For a supplied diff or summary,
use that material without requiring repository access.

Describe the actual change and its purpose. Do not invent motivation,
issue references, test results, or effects unsupported by the available
context. Ask for missing context only when needed to write an accurate
message. A request for a message alone does not authorize a commit.

## Apply these conventions

1. Separate the subject from the body with one blank line. A subject alone
   is sufficient when the change is simple and needs no further context.
2. Aim for a subject of 50 characters or fewer, counting spaces and any
   prefixes. Use up to 72 characters only when necessary for clarity;
   never exceed 72.
3. Start the subject with a capital letter. Use sentence case, not title
   case.
4. Do not end the subject with a period.
5. Use the imperative mood: "Fix bug", not "Fixed bug" or "Fixes bug".
   Check that it completes: "If applied, this commit will [subject]."
6. Hard-wrap body lines at 72 characters, including bullet indentation.
   Separate paragraphs with blank lines.
7. Explain what changed and why in the body. Describe the problem and
   intended outcome; include relevant consequences or tradeoffs. Avoid
   narrating implementation details already apparent in the diff.
8. Never include "Co-Authored-By:", tool signatures, or any other
   unnecessary AI indicators in the subject, body, or trailers.

Use a plain imperative subject by default. Do not add Conventional Commits
prefixes such as `feat:` or `fix:` unless explicitly requested. The linked
cheatsheet does not introduce additional formatting requirements.

## Validate the exact message

Before returning a message or running `git commit`, check subject length,
capitalization, imperative phrasing, the absence of a trailing period,
blank-line separation, and body line lengths. Ensure the message contains no
"Co-Authored-By:" lines or unnecessary AI indicators, covers only the
intended changes, and adds useful context in the body.

For an authorized commit, write the complete message to a temporary file,
hard-wrap its body, and pass that file with `git commit --file`. Git does
not wrap text supplied with `-m`, and `git diff --check` does not inspect
commit messages. In this repository, the `commit-msg` hook checks the
mechanical rules; review imperative wording, sentence case, and the
message's meaning yourself. After committing or amending, inspect the
actual message with `git show -s --format=%B HEAD`. Fix a malformed local,
unpublished commit before continuing; do not rewrite published history
without authorization.

When asked only for a commit message, return one ready-to-copy message in
a fenced text block, without commentary unless the user requests it.

Example:

```text
Preserve settings when restarting the app

Save user preferences between sessions so reopening the app keeps
chosen controls and audio levels. Previously, each restart restored
the defaults and required users to configure them again.
```

## References

These instructions contain the requested conventions; routine message
writing does not require opening the references.

- [How to Write a Git Commit Message](https://cbea.ms/git-commit/)
- [Git commit message guidelines](https://www.theserverside.com/video/Follow-these-git-commit-message-guidelines)
- [Imperative wording reference](https://gist.github.com/qoomon/5dfcdf8eec66a051ecd85625518cfd13)
