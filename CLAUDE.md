# Working on Kasboek

## Every new installer build
Before starting the "Build installers" workflow, raise the version and commit it:
- `npm version <patch|minor> --no-git-tag-version` (updates package.json and package-lock.json).
  Patch for fixes only, minor when there are new features.
- Update `.github/release-notes.md` for that version.
- Commit, push, then start the build. Never build twice under the same version number.

## Coding work
The main conversation acts as project manager: it splits coding work into tasks and sends each one directly to the right `dev-team` specialist (`architect`, `implementer`, `test-writer`, `code-reviewer`, `security-reviewer`, `docs-writer`), then combines their reports. Subagents can't start other subagents, so don't route work through `dev-team:project-manager`. Don't do coding work directly in the main conversation.
