@echo off
cd /d "%~dp0"
echo ============================================
echo  Aligning local repo to main (deploy branch)
echo ============================================
echo.
echo [1/4] Dropping local line-ending noise...
git reset --hard
echo.
echo [2/4] Fetching and pruning deleted branches...
git fetch --prune origin
echo.
echo [3/4] Switching to main...
git checkout -B main origin/main
echo.
echo [4/4] Removing stale local master...
git branch -D master
echo.
echo ============================================
echo  Current branch:
git rev-parse --abbrev-ref HEAD
echo ============================================
echo  Done. You are now on main.
echo.
pause
