@echo off
node "%~dp0fake-claude.js" %*
exit /b %errorlevel%
