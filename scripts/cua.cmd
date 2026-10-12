@echo off
setlocal
set "SCRIPT=%~dp0cua.mjs"
set "NODE_EXE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"
"%NODE_EXE%" "%SCRIPT%" %*
exit /b %ERRORLEVEL%