@echo off
chcp 65001 >nul
setlocal
pushd "%~dp0"
if errorlevel 1 goto directory_error
where node >nul 2>&1
if errorlevel 1 goto node_missing
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)"
if errorlevel 1 goto node_old
echo 正在启动书签桥接服务或连接已有服务的实时状态……
node "bridge\server.mjs"
set "BRIDGE_EXIT_CODE=%ERRORLEVEL%"
if not "%BRIDGE_EXIT_CODE%"=="0" echo 启动或状态查看异常退出，请查看上方错误信息。
echo 当前服务或状态查看窗口已退出；若此前连接的是已有服务，原服务仍在运行。
popd
pause
exit /b %BRIDGE_EXIT_CODE%

:node_missing
echo 未找到 Node.js。请打开 https://nodejs.org/ 安装 Node.js 22 或更高版本。
echo 安装时保留“Add to PATH”选项，然后关闭此窗口并重新双击 start-bridge.cmd。
goto failed

:node_old
echo 当前 Node.js 版本过旧或无法运行。本服务需要 Node.js 22 或更高版本。
echo 请从 https://nodejs.org/ 安装新版，然后关闭此窗口并重新启动。
goto failed

:directory_error
echo 无法进入程序所在目录。请将完整的 bookmark-bridge 文件夹放到可访问的位置后重试。
pause
exit /b 1

:failed
popd
pause
exit /b 1
