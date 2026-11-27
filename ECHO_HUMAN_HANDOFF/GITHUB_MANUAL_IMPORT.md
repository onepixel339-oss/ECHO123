# ECHO — Manual GitHub Import Guide

**Context:** the agent works with GitHub intentionally disconnected (no
pushes, no API calls). The delivery package in `download/` contains the
complete, verified state. You import it once; after that, repository access
can be reconnected for the agent's final review if you choose.

## The package (download/)

| Artifact | What it is |
|---|---|
| `echo-repository.bundle` | FULL Git history (all branches and the exact HEAD) |
| `echo-source.zip` | The source tree without `.git` (fallback import + inspection) |
| `SHA256SUMS.txt` | Checksums for every delivered artifact |
| `TREE_MANIFEST.txt` | Tracked-file count + per-file SHA-256 (fidelity check) |
| `FINAL_DELIVERY_REPORT.md` | What changed, test evidence, what is NOT done |
| `README_FIRST.md` | The one-page owner order of operations |

## Option A — import via the bundle (recommended: preserves history)

Requires git on your machine (any OS; GitHub Desktop also works).

```bash
# 1. verify the package first
cd <where you saved the download folder>
sha256sum -c SHA256SUMS.txt          # every line must say OK

# 2. clone from the bundle (it behaves exactly like a remote)
git clone echo-repository.bundle echo-imported
cd echo-imported
git log --oneline -5                 # expect the 1.3.0 commits on top
git branch -a                        # main, echo/autonomous-execution, …

# 3. create an EMPTY repository on github.com (no README, no license,
#    no .gitignore — anything pre-created causes a rejected push)

# 4. push everything to it (use your own account/repo name)
git remote add origin https://github.com/<you>/echo.git
git push --all origin
git push origin echo/autonomous-execution   # ensure the working branch is there

# 5. in the GitHub UI: Settings → Branches → set the default branch to
#    echo/autonomous-execution (the branch the delivery verified)
```

**Success check:** the repository's file count matches
`TREE_MANIFEST.txt`'s header (and `sha256` spot-checks match); the Actions
tab shows the CI workflow starting on your push.

## Option B — upload the source archive (no git needed)

1. Create the repository on github.com (**do not** add README/license/
   .gitignore).
2. `echo-source.zip` → extract → upload its CONTENTS through the web UI
   ("uploading an existing file" → drag the extracted folders).
   - The web uploader handles folders; verify `.github/workflows/ci.yml`
     made it up (hidden folders are easy to miss).
3. Commit directly to the default branch.
4. History note: this path starts history at one commit. The bundle remains
   your full-history record; keep it with the backups.

**Success check:** same as Option A (file count + CI started). If
`.github/workflows/ci.yml` is missing, add it manually from the archive
before expecting any CI run.

## What the CI run will do (first real run ever)

The workflow runs on every push: lint, typecheck, 472 unit tests,
secret-scan (+ self-test), version check, cost-table check, the production
build, the 32-test e2e suite (providers mocked — no live calls), and the
sync database suites on an embedded PostgreSQL 19. Everything passed
locally on the exact tree you are importing; the GitHub runners are the
same class of environment. **Until this run finishes green, CI status is
"local-verified only" — that is the honest state.**

If a job fails: copy the failing log (Actions → the run → the red job →
the gear icon → "Download log archive") and send it with the
`NEXT_AGENT_MESSAGE.txt` text. The fix comes back as a local patch + a new
package — the agent never pushes to your repository.

## After the import (optional but recommended)

If you reconnect repository access for the agent's final review, it will
only: compare the remote tree against `TREE_MANIFEST.txt`, inspect the real
CI run, and propose (never execute) any cleanup. Nothing is overwritten
without your approval.
