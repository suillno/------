@echo off
rem Meeting Assistant local launcher: Docker, Supabase, Edge Functions, desktop app.
rem ExecutionPolicy Bypass applies to this one process only; the system policy is not changed.
chcp 65001 > nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-local.ps1" %*
