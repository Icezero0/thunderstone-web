@echo off
setlocal
pushd "%~dp0.."
node -e "const [major,minor]=process.versions.node.split('.').map(Number);if(major<22||(major===22&&minor<12)){console.error('[ERROR] Node.js 22.12+ is required.');process.exit(1)}"
if errorlevel 1 (
    popd
    exit /b 1
)
if not exist node_modules (
    echo [ERROR] Dependencies are not installed. Run npm ci at the project root first.
    popd
    exit /b 1
)
call npm run dev --workspace @thunderstone/frontend -- %*
set "THUNDERSTONE_LAUNCH_EXIT=%ERRORLEVEL%"
popd
exit /b %THUNDERSTONE_LAUNCH_EXIT%
