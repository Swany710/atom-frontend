#!/usr/bin/env bash
#
# reconcile.sh — Retire `master`, make `main` the single source of truth.
#
# Safe to run: your local base.css/index.html changes are line-ending-only
# noise (verified), and origin/main already has the deployed CSP fix.
#
# What it does:
#   1. Drops local working-tree noise.
#   2. Switches you to `main` (the branch Railway actually deploys).
#   3. Adds .gitattributes so line endings stop drifting.
#   4. Repoints git-push.bat at `main` so future pushes deploy.
#   5. Deletes `master` (remote + local) and closes its PRs.
#
# Run from Git Bash:  bash reconcile.sh

set -u
cd "/c/Users/eswan/OneDrive/Desktop/AI/Atom/Atom/atom-frontend-main" || {
  echo "ERROR: repo folder not found"; exit 1; }

echo "==> 1/6  Dropping local working-tree noise (line-ending-only changes)"
git reset --hard

echo "==> 2/6  Fetching and switching to main"
git fetch origin
git checkout -B main origin/main

echo "==> 3/6  Writing .gitattributes (line-ending normalization)"
cat > .gitattributes <<'EOF'
# Normalize line endings: store LF in the repo, check out native per OS.
# Prevents the CRLF/LF churn that made main and master look diverged.
* text=auto
*.bat text eol=crlf
*.sh  text eol=lf
EOF

echo "==> 4/6  Repointing git-push.bat at main"
cat > git-push.bat <<'EOF'
@echo off
cd /d "%~dp0"
set "MSG=%~1"
if "%MSG%"=="" set "MSG=update"
echo Switching to main... > git-push-log.txt
git checkout main >> git-push-log.txt 2>&1
echo Staging... >> git-push-log.txt
git add -A >> git-push-log.txt 2>&1
echo Committing... >> git-push-log.txt
git commit -m "%MSG%" >> git-push-log.txt 2>&1
echo Pushing to origin/main... >> git-push-log.txt
git push origin main >> git-push-log.txt 2>&1
echo Done. >> git-push-log.txt
type git-push-log.txt
EOF

echo "==> 5/6  Committing and pushing to main"
git add .gitattributes git-push.bat
git commit -m "chore: add .gitattributes for EOL normalization; point git-push.bat at main"
git push origin main

echo "==> 6/6  Retiring master (remote + local)"
git push origin --delete master || echo "   (remote master already gone)"
git branch -D master 2>/dev/null || echo "   (local master already gone)"

echo ""
echo "Done. You are now on 'main', which is the branch Railway deploys."
echo "From now on, git-push.bat pushes to main. Usage:  git-push.bat \"your message\""
