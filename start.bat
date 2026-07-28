@echo off
cd /d "%~dp0"

:: 从 package.json 读取版本号
for /f "tokens=2 delims=:," %%a in ('findstr "version" package.json') do set VER=%%a
set VER=%VER:"=%
set VER=%VER: =%

echo 启动 MD_Board v%VER%（源码模式）...
echo 如需打包，请运行 npm run pack
start /min cmd /c "npm start"

