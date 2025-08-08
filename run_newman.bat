@echo off
setlocal

:: 더블클릭 시 새 콘솔 창에서 재실행되도록 설정
if "%~1"=="" (
    start "" cmd /k "%~f0" run
    exit /b
)

chcp 65001 >nul
cd /d "%~dp0"

REM === 파일 이름 설정 ===
set "COLLECTION=Danal_Uas_v1.0.postman_collection.json"
set "ENVIRONMENT=Danal_Uas_v1.0.postman_environment.json"

REM === 오늘 날짜 + 시분초 얻기 (YYYY-MM-DD_HH-MM-SS)
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd_HHmmss"') do set "DATETIME=%%i"

set "COLLECTION_NAME=%COLLECTION:.postman_collection.json=%"
set "REPORT_PATH=reports\%DATETIME%_%COLLECTION_NAME%.html"

REM === 리포트 폴더 생성 ===
if not exist reports (
    mkdir reports
)

echo [INFO] Collection: %COLLECTION_NAME%
echo [INFO] Environment: %ENVIRONMENT%
echo [INFO] Report Path: %REPORT_PATH%
echo [DEBUG] Starting Newman...

REM === newman 실행
newman run "%COLLECTION%" -e "%ENVIRONMENT%" -r cli,htmlextra ^
    --reporter-htmlextra-export "%REPORT_PATH%" ^
    --reporter-htmlextra-title "Danal Uas API Test Report" ^
    --insecure

echo [DEBUG] Newman finished! Exit code: %ERRORLEVEL%

REM === 리포트 자동 열기
if exist "%REPORT_PATH%" (
    start "" "%REPORT_PATH%"
) else (
    echo [ERROR] Report file not found: %REPORT_PATH%
)

echo.
echo [INFO] 작업이 완료되었습니다. 콘솔을 닫으려면 아무 키나 누르세요.
pause >nul