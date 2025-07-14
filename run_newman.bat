@echo off
REM 실행 경로 설정
cd /d "%~dp0"

REM 컬렉션 및 환경 파일 이름 설정
set COLLECTION=Danal_Uas_v1.0.postman_collection.json
set ENVIRONMENT=Danal_Uas_v1.0.postman_environment.json

REM 현재 날짜 (형식: YYYY-MM-DD)
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set TODAY=%%i

REM 파일 이름에서 .json 제거
set "COLLECTION_NAME=%COLLECTION:.postman_collection.json=%"

REM 리포트 디렉토리 생성
if not exist reports (
    mkdir reports
)

REM 리포트 경로 및 이름 설정
set REPORT_PATH=reports\%TODAY%_%COLLECTION_NAME%.html

REM newman 실행 (htmlextra 리포터 사용) + 인증서 오류 무시
newman run "%COLLECTION%" -e "%ENVIRONMENT%" ^
    -r cli,htmlextra ^
    --reporter-htmlextra-export "%REPORT_PATH%" ^
    --reporter-htmlextra-title "Danal Uas API Test Report" ^
    --insecure

echo.
echo ▶ 테스트 완료! 리포트는 %REPORT_PATH% 에 생성되었습니다.
