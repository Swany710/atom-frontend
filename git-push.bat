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
