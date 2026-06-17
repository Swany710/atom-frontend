@echo off
cd /d "%~dp0"
echo Staging changed files... > git-push-log.txt
git add public/index.html public/js/chat.js server.js >> git-push-log.txt 2>&1
echo. >> git-push-log.txt
echo Committing... >> git-push-log.txt
git commit -m "fix: CSP allows OpenAI WebSocket, fix send button re-enable bug, close settings modal divs" >> git-push-log.txt 2>&1
echo. >> git-push-log.txt
echo Pushing to origin... >> git-push-log.txt
git push origin HEAD >> git-push-log.txt 2>&1
echo. >> git-push-log.txt
echo Done. >> git-push-log.txt
