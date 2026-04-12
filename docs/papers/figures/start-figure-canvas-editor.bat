@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if %errorlevel%==0 (
  node serve_figure_canvas_editor.mjs
  goto :eof
)

where py >nul 2>nul
if %errorlevel%==0 (
  py serve_figure_canvas_editor.py
  goto :eof
)

where python >nul 2>nul
if %errorlevel%==0 (
  python serve_figure_canvas_editor.py
  goto :eof
)

echo Neither Node.js nor Python was found.
echo Install one of them, then run this file again.
pause
