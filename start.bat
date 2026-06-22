@echo off
cd /d "%~dp0"
echo 启动 MD_Board v2.0（源码模式）...
echo 如需打包，请运行 npm run pack
start /min cmd /c "npm start"

