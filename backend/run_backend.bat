@echo off
setlocal
set "THUNDERSTONE_ROOT=%~dp0.."
set "THUNDERSTONE_PYTHON=%THUNDERSTONE_ROOT%\.venv\Scripts\python.exe"
if not exist "%THUNDERSTONE_PYTHON%" (
    echo [ERROR] Project virtualenv was not found: %THUNDERSTONE_PYTHON%
    echo Create .venv at the project root and install backend\requirements.txt first.
    exit /b 1
)
pushd "%THUNDERSTONE_ROOT%"
"%THUNDERSTONE_PYTHON%" "%~dp0run_backend.py" %*
set "THUNDERSTONE_LAUNCH_EXIT=%ERRORLEVEL%"
popd
exit /b %THUNDERSTONE_LAUNCH_EXIT%
