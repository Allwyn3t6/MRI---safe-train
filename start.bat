@echo off
rem MRISafe Twin - start the local server and open the app in your browser
cd /d "%~dp0"
set PY=

rem 1. The Python launcher (py.exe). Run it, don't just look for it.
py -3 --version >nul 2>nul && set PY=py -3
if defined PY goto found

rem 2. python on PATH. Run it too: the Microsoft Store stub is on PATH but fails.
python --version >nul 2>nul && set PY=python
if defined PY goto found

rem 3. Standard install folders, in case PATH was not set up during install.
if exist "%LOCALAPPDATA%\Programs\Python\Python313\python.exe" (
  set "PY="%LOCALAPPDATA%\Programs\Python\Python313\python.exe""
  goto found
)
if exist "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" (
  set "PY="%LOCALAPPDATA%\Programs\Python\Python312\python.exe""
  goto found
)
if exist "%LOCALAPPDATA%\Programs\Python\Python311\python.exe" (
  set "PY="%LOCALAPPDATA%\Programs\Python\Python311\python.exe""
  goto found
)
if exist "%LOCALAPPDATA%\Programs\Python\Python310\python.exe" (
  set "PY="%LOCALAPPDATA%\Programs\Python\Python310\python.exe""
  goto found
)
if exist "%LOCALAPPDATA%\Programs\Python\Python39\python.exe" (
  set "PY="%LOCALAPPDATA%\Programs\Python\Python39\python.exe""
  goto found
)
if exist "%ProgramFiles%\Python311\python.exe" (
  set "PY="%ProgramFiles%\Python311\python.exe""
  goto found
)

echo.
echo Python was not found.
echo.
echo Fix it in one of these ways, then run start.bat again:
echo   1. Install Python 3.11 from https://www.python.org/downloads/ and tick
echo      "Add python.exe to PATH" on the first screen.
echo   2. Or, if Python 3.11 is already installed, open Settings, Apps,
echo      Advanced app settings, App execution aliases, and turn OFF the
echo      "python.exe" and "python3.exe" entries that point to the Store.
echo.
pause
exit /b 1

:found
echo Using Python: %PY%
%PY% --version
%PY% server\server.py --open
echo.
echo The server has stopped. If you see an error above, take a screenshot of this window.
pause
