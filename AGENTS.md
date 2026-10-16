# Working on this repo

- **Work on a branch** and open a PR; never commit to `main`. No tool prefixes
  on branch names, no `Co-authored-by` trailers or "generated with" footers.
- **Every bug fix gets a test, and check it fails without the fix.**
- **Before you push:** `npm run typecheck && npm run lint && npm run format:check && npm test && npm run build`, checking each exit code.
- **Keep the packages free of any one application's concepts.** They're
  libraries: no league, recorder or journal in names or comments.
- Comments say why, not what.
