# Working on Kasboek

## Every new installer build
Before starting the "Build installers" workflow, raise the version and commit it:
- `npm version <patch|minor> --no-git-tag-version` (updates package.json and package-lock.json).
  Patch for fixes only, minor when there are new features.
- Update `.github/release-notes.md` for that version.
- Commit, push, then start the build. Never build twice under the same version number.

## Coding work
Send every coding request and every question about the code to the `dev-team:project-manager` agent, which assigns the right specialist. Don't do coding work directly in the main conversation.
