@echo off
chcp 65001 > nul
cd /d "%~dp0"
title My Dyatel Medical Portal
echo ========================================================
echo   МЕДИЦИНСКИЙ ПОРТАЛ 'MY DYATEL' (HTML / CSS / SQLITE)
echo   ООП: Абстрактные классы (AbstractUser, AbstractDoctor)
echo ========================================================
echo.
echo Запуск локального сервера...

py -3 --version >nul 2>nul
if %errorlevel%==0 (
    py -3 main.py
    goto :end
)

python --version >nul 2>nul
if %errorlevel%==0 (
    python main.py
    goto :end
)

echo [ОШИБКА] Python не найден. Установите Python 3 с https://www.python.org/
:end
pause