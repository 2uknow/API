# 📋 SClient YAML 시나리오 완전 가이드

> **🆕 최신 업데이트 (2025-08-27)**  
> - 간단한 키워드 추출 방식 도입 (정규식 불필요)
> - 변수 매핑 시스템 간소화 (복잡한 테이블 제거)
> - PM 객체 매핑 문제 해결
> - CAP 필드 대소문자 문제 해결
> - HTML 리포트에 변수명 영어 표시 개선

## 📖 목차
1. [기본 구조](#기본-구조)
2. [Variables 섹션](#variables-섹션)
3. [Steps 섹션](#steps-섹션)
4. [Extract 섹션](#extract-섹션)
5. [Test 섹션](#test-섹션)
6. [Options 섹션](#options-섹션)
7. [SClient 명령어 레퍼런스](#sclient-명령어-레퍼런스)
8. [실전 예제](#실전-예제)
9. [디버깅 가이드](#디버깅-가이드)
10. [모범 사례](#모범-사례)

---

## 📚 기본 구조

### YAML 파일의 전체 구조
```yaml
# 주석은 # 으로 시작
name: "시나리오 이름"
description: "시나리오 설명"
version: "1.0.0"

# 전역 변수 정의
variables:
  VARIABLE_NAME: "값"
  ANOTHER_VAR: "다른 값"

# 실행 단계들
steps:
  - name: "첫 번째 단계"
    command: "COMMAND_NAME"
    # ... 단계 설정
  
  - name: "두 번째 단계"
    command: "ANOTHER_COMMAND"
    # ... 단계 설정

# 시나리오 옵션
options:
  stopOnError: true
  timeout: 30000
  retryCount: 0
```

### 중요한 YAML 문법 규칙
1. **들여쓰기**: 공백 2개 또는 4개 (일관성 유지)
2. **대소문자 구분**: 모든 키와 값은 대소문자를 구분
3. **따옴표**: 문자열은 쌍따옴표(`"`) 사용 권장
4. **배열**: `-` 기호로 시작
5. **주석**: `#` 기호로 시작

---

## 🔧 Variables 섹션

### 기본 변수 정의
```yaml
variables:
  # 문자열 변수
  MERCHANT_ID: "A010002002"
  SERVICE_NAME: "TELEDIT"
  USER_EMAIL: "test@example.com"
  
  # 숫자 변수 (따옴표로 감싸기)
  AMOUNT: "1000"
  TIMEOUT: "5000"
  
  # 복잡한 문자열
  ITEM_INFO: "2|1000|1|22S0HZ0100|상품명"
  
  # 특수 문자 포함
  PASSWORD: "pass@word123!"
```

### 변수 사용법
```yaml
steps:
  - name: "변수 사용 예제"
    command: "ITEMSEND2"
    args:
      ID: "{{MERCHANT_ID}}"           # 기본 변수 참조
      PWD: "{{PASSWORD}}"
      AMOUNT: "{{AMOUNT}}"
      EMAIL: "{{USER_EMAIL}}"
```

### 시스템 내장 변수
```yaml
variables:
  # 현재 타임스탬프 (자동 생성)
  ORDER_ID: "ORDER_{{timestamp}}"
  
  # 랜덤 문자열 (자동 생성)
  RANDOM_ID: "TEST_{{random}}"
```

### 변수명 명명 규칙
- **대문자 + 언더스코어** 사용: `MERCHANT_ID`, `USER_EMAIL`
- **의미 있는 이름** 사용: `PWD`보다는 `MERCHANT_PASSWORD`
- **일관성 유지**: 프로젝트 전체에서 동일한 패턴 사용

---

## 📝 Steps 섹션

### 기본 단계 구조
```yaml
steps:
  - name: "단계 이름"                    # 필수: 단계 설명
    description: "상세 설명"              # 선택: 단계에 대한 자세한 설명
    command: "SClient_명령어"            # 필수: 실행할 명령
    args:                               # 필수: 명령어 인수들
      매개변수1: "값1"
      매개변수2: "값2"
    extract:                            # 선택: 응답에서 데이터 추출
      - name: "추출명"
        pattern: "정규표현식"
        variable: "저장변수명"
    test:                              # 선택: 검증 조건들
      - "검증조건1"
      - "검증조건2"
```

### 단계 이름 작성 가이드
```yaml
steps:
  # ✅ 좋은 예
  - name: "상점 인증 확인"
  - name: "결제 요청 전송"
  - name: "거래 상태 조회"
  - name: "결제 취소 처리"
  
  # ❌ 나쁜 예
  - name: "테스트1"
  - name: "auth"
  - name: "step2"
```

### Args 섹션 상세
```yaml
args:
  # 필수 파라미터
  SERVICE: "{{SERVICE_NAME}}"
  ID: "{{MERCHANT_ID}}"
  PWD: "{{MERCHANT_PWD}}"
  
  # 선택 파라미터
  TIMEOUT: "{{TIMEOUT_VALUE}}"
  RETRY: "3"
  
  # 복잡한 파라미터
  ItemInfo: "2|{{AMOUNT}}|1|{{ITEM_CODE}}|{{ITEM_NAME}}"
  
  # Boolean 값 (문자열로 전달)
  IsPreOtbill: "Y"
  IsOpenMarket: "N"
  
  # 조건부 파라미터 (특정 명령어에서만 사용)
  AUTHKEY: "{{AUTH_KEY}}"      # DELIVER 명령어에서 필요
  TID: "{{TRANSACTION_ID}}"    # CONFIRM 명령어에서 필요
```

---

## 🔍 Extract 섹션

### 기본 추출 문법
```yaml
extract:
  - name: "추출할 데이터 이름"
    pattern: "정규표현식"
    variable: "저장할 변수명"
```

### 주요 추출 패턴들

#### 1. 간단한 키워드 추출 (권장)
```yaml
extract:
  # ✅ 새로운 간단한 방식 (2025-08-27 업데이트)
  - name: "result"
    pattern: "Result"              # 키워드만으로 추출
    variable: "RESULT_CODE"
  
  - name: "serverInfo"
    pattern: "ServerInfo"          # 키워드만으로 추출
    variable: "SERVER_INFO"
  
  - name: "errMsg"
    pattern: "ErrMsg"              # 키워드만으로 추출
    variable: "ERROR_MESSAGE"
  
  # 사용 예시:
  # 응답: "Result=0\r\nServerInfo=abcd1234\r\nErrMsg=Invalid Password\r\n"
  # 결과: 
  # - RESULT_CODE = "0"
  # - SERVER_INFO = "abcd1234" 
  # - ERROR_MESSAGE = "Invalid Password"
```

#### 2. 복잡한 정규식 방식 (기존 호환)
```yaml
extract:
  # ❌ 복잡한 기존 방식 (호환성을 위해 지원)
  - name: "result_code"
    pattern: "Result\\s*=\\s*([0-9-]+)"
    variable: "RESULT"
  
  - name: "auth_key"
    pattern: "AuthKey=([A-Za-z0-9]+)"
    variable: "AUTH_KEY"
  
  - name: "error_message"  
    pattern: "ErrMsg=(.+?)[\\r\\n]"
    variable: "ERROR_MSG"
```

#### 3. 추출 방식 선택 가이드
```yaml
# ✅ 권장: 간단한 키워드 방식
# - 읽기 쉽고 실수 위험이 적음
# - 대소문자 구분 없이 자동 매칭
# - 정규식 지식 불필요

extract:
  - name: "result"
    pattern: "Result"              # 간단!
    variable: "RESULT_CODE"

# ❌ 비권장: 복잡한 정규식
# - 정규식 문법 실수 위험
# - 대소문자 민감
# - 유지보수 어려움

extract:  
  - name: "result"
    pattern: "Result\\s*=\\s*([0-9-]+)"  # 복잡하고 실수하기 쉬움
    variable: "RESULT_CODE"
```

#### 4. 자주 사용하는 키워드들
```yaml
extract:
  # 기본 응답 필드들
  - name: "result"
    pattern: "Result"
    variable: "RESULT_CODE"
  
  - name: "serverInfo"  
    pattern: "ServerInfo"
    variable: "SERVER_INFO"
    
  - name: "errMsg"
    pattern: "ErrMsg" 
    variable: "ERROR_MESSAGE"
  
  # 인증 관련
  - name: "authKey"
    pattern: "AuthKey"
    variable: "AUTH_KEY"
    
  - name: "tid"
    pattern: "TID"
    variable: "TRANSACTION_ID"
  
  # 추가 필드들
  - name: "cap"
    pattern: "CAP"                 # 대소문자 무관하게 자동 매칭
    variable: "CAP_CODE"
    
  - name: "ansimmember"
    pattern: "ANSIMMEMBER"
    variable: "ANSIM_MEMBER"
```

### 정규표현식 패턴 가이드

#### 기본 문자 클래스
```yaml
# 숫자만
pattern: "Result=([0-9]+)"

# 숫자와 음수 기호
pattern: "Result=([0-9-]+)"

# 영문자만 (대소문자)
pattern: "Status=([A-Za-z]+)"

# 영숫자
pattern: "AuthKey=([A-Za-z0-9]+)"

# 16진수
pattern: "ServerInfo=([A-Fa-f0-9]+)"

# 모든 문자 (줄바꿈 제외)
pattern: "Message=(.+)"

# 모든 문자 (최소 매칭, 줄바꿈까지)
pattern: "ErrMsg=(.+?)[\r\n]"
```

#### 고급 패턴
```yaml
# 이메일 주소
pattern: "Email=([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,})"

# 전화번호 (010-1234-5678)
pattern: "Phone=([0-9]{3}-[0-9]{4}-[0-9]{4})"

# 날짜 (YYYY-MM-DD)
pattern: "Date=([0-9]{4}-[0-9]{2}-[0-9]{2})"

# 시간 (HH:MM:SS)
pattern: "Time=([0-9]{2}:[0-9]{2}:[0-9]{2})"

# IP 주소
pattern: "IP=([0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3})"
```

---

## ✅ Test 섹션

### 기본 테스트 문법
```yaml
test:
  - "조건문"
```

### 1. 존재 확인 테스트
```yaml
test:
  - "result exists"              # result 변수가 존재하는지
  - "authKey exists"             # authKey 변수가 존재하는지
  - "ERROR_MSG exists"           # 추출된 변수가 존재하는지
```

### 2. 값 비교 테스트
```yaml
test:
  # 정확히 일치
  - "result == 0"               # 성공 코드
  - "result == -1"              # 실패 코드
  - "status == SUCCESS"         # 문자열 비교
  - "amount == 1000"            # 숫자 비교
  
  # 일치하지 않음
  - "result != -999"            # -999가 아님
  - "status != ERROR"           # ERROR가 아님
```

### 3. 숫자 범위 테스트
```yaml
test:
  # 크기 비교
  - "amount > 0"                # 0보다 큼
  - "amount >= 100"             # 100 이상
  - "amount < 10000"            # 10000 미만
  - "amount <= 5000"            # 5000 이하
  
  # 범위 확인
  - "responseTime > 0"          # 응답시간이 0보다 큼
  - "responseTime < 30000"      # 30초 미만
  - "errorCount <= 5"           # 에러 횟수 5회 이하
```

### 4. 문자열 포함/미포함 테스트
```yaml
test:
  # 포함 확인
  - "message contains 'SUCCESS'"     # 성공 메시지 포함
  - "response contains 'OK'"         # OK 포함
  - "authKey contains 'DN'"          # DN으로 시작하는 키
  
  # 미포함 확인
  - "errMsg not contains '오류'"      # 오류 문자 없음
  - "response not contains 'FAIL'"   # FAIL 없음
  - "message not contains 'ERROR'"   # ERROR 없음
```

### 5. 정규표현식 매칭 테스트
```yaml
test:
  # 이메일 형식 확인
  - "email matches '^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$'"
  
  # 전화번호 형식 확인
  - "phone matches '^010-[0-9]{4}-[0-9]{4}$'"
  
  # 거래번호 형식 확인
  - "tid matches '^[A-Z0-9]{10,20}$'"
  
  # 날짜 형식 확인
  - "date matches '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'"
```

### 6. JavaScript 조건부 테스트 (고급)

JavaScript 표현식을 사용하여 복잡한 조건 로직을 구현할 수 있습니다.

#### 기본 JavaScript 테스트 문법
```yaml
test:
  - "js: JavaScript_조건식"
```

#### 사용 가능한 변수들
테스트에서 사용할 수 있는 JavaScript 변수들:

```yaml
test:
  # extract 섹션에서 추출된 변수들을 JavaScript에서 사용
  - "js: result == '0'"          # RESULT_CODE -> result
  - "js: serverinfo.length > 0"  # SERVER_INFO -> serverinfo  
  - "js: errmsg.includes('ERROR')" # ERROR_MESSAGE -> errmsg
  - "js: authkey.startsWith('DN')" # AUTH_KEY -> authkey
```

**변수 매핑 규칙 (2025-08-27 간소화):**
- 추출된 변수명을 소문자로 변환: `RESULT_CODE` → `result`
- 언더스코어 제거: `SERVER_INFO` → `serverinfo`
- `ERROR_MESSAGE` → `errmsg` (단순 소문자 변환)
- 복잡한 매핑 테이블 제거, 대소문자 변환만 수행

#### JavaScript 조건부 테스트 예제

##### 1. 기본 조건문
```yaml
test:
  # 성공(0) 또는 테스트 환경 에러(3)만 허용
  - "js: result == '0' || result == '3'"
  
  # 실패시에만 에러메시지 필수
  - "js: result == '0' || (result != '0' && errmsg && errmsg.length > 0)"
  
  # 성공이면 serverinfo 필드가 존재해야 하고, 실패시에는 errmsg 필드가 존재해야 함
  - "js: (result == '0' && serverinfo) || (result != '0' && errmsg)"
```

##### 2. 조건부 검증 로직
```yaml
test:
  # result가 0이면 serverinfo 체크 안함, 0이 아니면 serverinfo 필수
  - "js: result == '0' || (result != '0' && serverinfo && serverinfo.length > 0)"
  
  # 삼항 연산자 사용
  - "js: result == '0' ? true : (serverinfo && serverinfo.length > 0)"
  
  # 특정 에러코드들만 허용
  - "js: ['0', '3', '1001', '1002'].includes(result)"
```

##### 3. 문자열 검증
```yaml
test:
  # 정규식 매칭
  - "js: /^DN[A-Z0-9]{16}$/.test(authkey)"
  
  # 문자열 포함 검사
  - "js: result == '0' || errmsg.includes('TEST')"
  
  # 대소문자 무시하고 포함 검사
  - "js: errmsg.toLowerCase().includes('invalid')"
  
  # 여러 키워드 중 하나라도 포함
  - "js: ['timeout', 'network', 'connection'].some(keyword => errmsg.toLowerCase().includes(keyword))"
```

##### 4. 시간 기반 조건
```yaml
test:
  # 업무시간(9-18시)에만 엄격한 체크
  - "js: new Date().getHours() < 9 || new Date().getHours() > 18 || result == '0'"
  
  # 주말에는 테스트 에러(3) 허용
  - "js: result == '0' || ([0, 6].includes(new Date().getDay()) && result == '3')"
  
  # 오전에는 다른 조건, 오후에는 다른 조건
  - "js: new Date().getHours() < 12 ? result == '0' : (result == '0' || result == '3')"
```

##### 5. 복합 조건 검증
```yaml
test:
  # 성공 케이스: result=0이고 authkey 필드가 존재해야 함
  # 실패 케이스: result!=0이고 errmsg 필드가 존재해야 함
  - "js: (result == '0' && authkey && authkey.length > 10) || (result != '0' && errmsg && errmsg.length > 0)"
  
  # 금액별 다른 검증 로직 (변수 사용)
  - "js: amount <= 1000 ? result == '0' : (result == '0' && serverinfo)"
  
  # 여러 필드 조합 검증
  - "js: result == '0' && authkey && tid && (!errmsg || errmsg.length == 0)"
```

##### 6. 실전 활용 예제

**ITEMSEND2 단계에서의 JavaScript 테스트:**
```yaml
steps:
  - name: "ITEMSEND2 - 결제 요청"
    command: "ITEMSEND2"
    args:
      # ... 기본 설정
    
    extract:
      - name: "result"
        pattern: "Result\\s*=\\s*([0-9-]+)"
        variable: "RESULT_CODE"
      - name: "serverInfo"
        pattern: "ServerInfo=([A-Fa-f0-9]+)"
        variable: "SERVER_INFO"
      - name: "errMsg"
        pattern: "ErrMsg=(.+?)[\\r\\n]"
        variable: "ERROR_MESSAGE"
      - name: "authKey"
        pattern: "AuthKey=([A-Za-z0-9]+)"
        variable: "AUTH_KEY"
    
    test:
      # 기본 존재 확인
      - "RESULT_CODE exists"
      
      # JavaScript 조건부 테스트들
      # 성공시 serverinfo와 authkey 필수, 실패시 errmsg 필수
      - "js: (result == '0' && serverinfo && authkey) || (result != '0' && errmsg)"
      
      # 성공(0) 또는 테스트 환경 에러(3)만 허용
      - "js: result == '0' || result == '3'"
      
      # authkey 형식 검증 (성공시에만)
      - "js: result != '0' || (authkey && authkey.startsWith('DN') && authkey.length >= 16)"
      
      # 업무시간에만 엄격한 검증
      - "js: new Date().getHours() < 9 || new Date().getHours() > 17 || result == '0'"
```

#### JavaScript에서 사용 가능한 Built-in 객체들

##### Date 객체
```yaml
test:
  # 현재 시간 정보
  - "js: new Date().getHours() >= 9"      # 현재 시간(시)
  - "js: new Date().getDay() != 0"        # 일요일 아님 (0=일요일)
  - "js: new Date().getMonth() == 7"      # 8월 (0부터 시작)
  - "js: new Date().getFullYear() >= 2024" # 2024년 이후
```

##### Math 객체  
```yaml
test:
  # 숫자 계산
  - "js: Math.abs(Number(amount) - 1000) < 100"  # 오차 범위 내
  - "js: Math.floor(Number(result)) >= 0"        # 정수 부분이 0 이상
  - "js: Math.random() > 0.5 || result == '0'"   # 50% 확률로 관대한 검증
```

##### Array 메서드
```yaml
test:
  # 배열 검사
  - "js: ['0', '3', '1001'].includes(result)"
  - "js: ['DN', 'KT', 'LG'].some(prefix => authkey.startsWith(prefix))"
  - "js: ['ERROR', 'FAIL', 'TIMEOUT'].every(keyword => !errmsg.includes(keyword))"
```

##### String 메서드
```yaml
test:
  # 문자열 처리
  - "js: authkey.toUpperCase().startsWith('DN')"
  - "js: errmsg.trim().length > 0"
  - "js: serverinfo.slice(0, 4) == 'abcd'"
  - "js: result.padStart(3, '0') == '000'"
```

#### JavaScript 테스트 모범 사례

##### ✅ 좋은 JavaScript 테스트 예제
```yaml
test:
  # 1. 기본 존재 확인 먼저
  - "result exists"
  - "serverinfo exists"
  
  # 2. JavaScript 조건부 검증
  - "js: result == '0' || (result == '3' && errmsg && errmsg.includes('TEST'))"
  
  # 3. 구체적인 조건
  - "js: result == '0' ? authkey && authkey.length > 10 : errmsg && errmsg.length > 5"
  
  # 4. 성능 고려 (단순한 조건부터)
  - "js: result == '0' || new Date().getHours() < 9"
```

##### ❌ 피해야 할 JavaScript 테스트
```yaml
test:
  # 존재 확인 없이 바로 JavaScript 사용 (에러 위험)
  - "js: result == '0' && serverinfo.length > 0"
  
  # 너무 복잡한 로직 (가독성 저하)
  - "js: (result == '0' && serverinfo && authkey && tid && amount > 0 && new Date().getHours() > 8) || (result != '0' && errmsg && errmsg.includes('ERROR') && !errmsg.includes('TIMEOUT'))"
  
  # 하드코딩된 값들
  - "js: result == '0' || result == '1001' || result == '2003' || result == '5007'"
```

#### 디버깅 팁

##### JavaScript 테스트 디버깅
```yaml
test:
  # 디버깅용: 모든 변수 값 출력
  - "js: console.log('DEBUG:', {result, serverinfo, errmsg, authkey}) || true"
  
  # 조건별 디버깅
  - "js: result == '0' || (console.log('Failed result:', result) && false)"
  
  # 단계적 조건 확인
  - "js: result == '0'"  # 첫 번째 조건만
  - "js: result == '0' || result == '3'"  # 두 번째 조건 추가
  - "js: result == '0' || (result == '3' && errmsg)"  # 세 번째 조건 추가
```

##### 실제 프로덕션에서 사용하는 패턴들
```yaml
# 현재 사용중인 패턴 (collections/simple_api_test.yaml에서)
test:
  # 성공시 serverinfo 필수, 실패시 errmsg 필수
  - "js: (result == '0' && serverinfo && serverinfo.length > 0) || (result != '0' && errmsg && errmsg.length > 0)"
  
  # 성공(0) 또는 테스트환경 에러(3)만 허용  
  - "js: result == '0' || result == '3'"
```

## 🎯 JavaScript 테스트 초보자 가이드

### 단계별 JavaScript 테스트 작성법

#### Step 1: 기본 변수 확인부터 시작

먼저 어떤 변수들이 추출되었는지 확인해보세요:

```yaml
# extract 섹션에서 이런 변수들을 추출했다면
extract:
  - name: "result"
    pattern: "Result\\s*=\\s*([0-9-]+)"
    variable: "RESULT_CODE"           # 이것이 JavaScript에서는 'result'가 됩니다
  - name: "serverInfo"
    pattern: "ServerInfo=([A-Fa-f0-9]+)"
    variable: "SERVER_INFO"           # 이것이 JavaScript에서는 'serverinfo'가 됩니다
  - name: "errMsg"
    pattern: "ErrMsg=(.+?)[\\r\\n]"
    variable: "ERROR_MESSAGE"         # 이것이 JavaScript에서는 'errmsg'가 됩니다

# 기본 존재 확인 (이것부터 먼저 하세요!)
test:
  - "RESULT_CODE exists"      # 변수가 존재하는지 확인
  - "SERVER_INFO exists"      # 변수가 존재하는지 확인
  - "ERROR_MESSAGE exists"    # 변수가 존재하는지 확인
```

#### Step 2: 간단한 JavaScript 조건부터 시작

```yaml
test:
  # 먼저 기본 존재 확인
  - "RESULT_CODE exists"
  
  # 1️⃣ 가장 간단한 JavaScript 테스트: 성공 여부만 확인
  - "js: result == '0'"
  
  # 위 코드의 의미:
  # - result 변수의 값이 '0'(성공)인지 확인
  # - 주의: 숫자가 아니라 문자열 '0'으로 비교!
```

#### Step 3: OR 조건 추가하기

```yaml
test:
  - "RESULT_CODE exists"
  
  # 2️⃣ 성공(0) 또는 다른 허용 코드(3) 체크
  - "js: result == '0' || result == '3'"
  
  # 위 코드의 의미:
  # - result가 '0'이면 통과 OR result가 '3'이면 통과
  # - ||는 OR 의미 (둘 중 하나라도 참이면 통과)
```

#### Step 4: 조건부 검증 (IF-THEN 로직)

```yaml
test:
  - "RESULT_CODE exists"
  - "SERVER_INFO exists"
  
  # 3️⃣ IF-THEN 로직: 성공시 serverinfo 필드 존재 검증
  - "js: result == '0' ? serverinfo.length > 0 : true"
  
  # 위 코드를 풀어서 설명하면:
  # IF (result == '0')    → 성공이면
  # THEN serverinfo.length > 0  → serverinfo 필드가 1글자 이상의 값을 포함해야 함
  # ELSE true             → 실패면 이 조건은 통과
  
  # 삼항 연산자: 조건 ? 참일때값 : 거짓일때값
```

#### Step 5: AND 조건 사용하기

```yaml
test:
  - "RESULT_CODE exists"
  - "SERVER_INFO exists"
  - "ERROR_MESSAGE exists"
  
  # 4️⃣ AND 조건: 모든 조건이 다 맞아야 함
  - "js: result == '0' && serverinfo && serverinfo.length > 0"
  
  # 위 코드의 의미:
  # - result가 '0'이어야 하고 (&&)
  # - serverinfo가 존재해야 하고 (&&)  
  # - serverinfo 필드가 1글자 이상의 값을 포함해야 함
  # - 세 조건이 모두 참이어야 통과
```

#### Step 6: 복합 조건 (OR + AND 조합)

```yaml
test:
  - "RESULT_CODE exists"
  - "SERVER_INFO exists"
  - "ERROR_MESSAGE exists"
  
  # 5️⃣ 복합 조건: 성공이면 serverinfo 필수, 실패면 errmsg 필수
  - "js: (result == '0' && serverinfo) || (result != '0' && errmsg)"
  
  # 위 코드를 풀어서 설명하면:
  # (result == '0' && serverinfo)     → 성공이고 serverinfo가 있으면 통과
  #           OR
  # (result != '0' && errmsg)         → 실패이고 errmsg가 있으면 통과
  # 
  # 괄호()는 우선순위를 정합니다!
```

### 🔍 실전 예제로 배우기

#### 예제 1: 단순한 성공/실패 체크

```yaml
# 상황: ITEMSEND2 결제 요청 후 결과만 확인하고 싶음
steps:
  - name: "결제 요청"
    command: "ITEMSEND2"
    args:
      # ... 기본 설정
    
    extract:
      - name: "result"
        pattern: "Result\\s*=\\s*([0-9-]+)"
        variable: "RESULT_CODE"
    
    test:
      - "RESULT_CODE exists"        # 기본 확인
      - "js: result == '0'"         # 성공만 허용
```

#### 예제 2: 여러 성공 코드 허용

```yaml
# 상황: 성공(0)과 테스트 환경 에러(3) 둘 다 허용하고 싶음
test:
  - "RESULT_CODE exists"
  - "js: result == '0' || result == '3'"
  
# 더 많은 코드를 허용하려면:
test:
  - "RESULT_CODE exists"  
  - "js: result == '0' || result == '3' || result == '1001'"
  
# 또는 배열을 사용해서 깔끔하게:
test:
  - "RESULT_CODE exists"
  - "js: ['0', '3', '1001'].includes(result)"
```

#### 예제 3: 조건부 필드 검증

```yaml
# 상황: 성공시 authkey 필드가 존재해야 하고, 실패시 errmsg 필드가 존재해야 함
extract:
  - name: "result"
    pattern: "Result\\s*=\\s*([0-9-]+)"
    variable: "RESULT_CODE"
  - name: "authKey"
    pattern: "AuthKey=([A-Za-z0-9]+)"
    variable: "AUTH_KEY"
  - name: "errMsg"
    pattern: "ErrMsg=(.+?)[\\r\\n]"
    variable: "ERROR_MESSAGE"

test:
  - "RESULT_CODE exists"
  
  # 방법 1: 삼항 연산자 사용
  - "js: result == '0' ? authkey && authkey.length > 0 : errmsg && errmsg.length > 0"
  
  # 방법 2: OR + AND 조합 (위와 같은 의미)
  - "js: (result == '0' && authkey && authkey.length > 0) || (result != '0' && errmsg && errmsg.length > 0)"
```

#### 예제 4: 문자열 포함 검사

```yaml
# 상황: 에러 메시지에 특정 단어가 포함되어야 함
extract:
  - name: "result"
    pattern: "Result\\s*=\\s*([0-9-]+)"
    variable: "RESULT_CODE"
  - name: "errMsg"
    pattern: "ErrMsg=(.+?)[\\r\\n]"
    variable: "ERROR_MESSAGE"

test:
  - "RESULT_CODE exists"
  - "ERROR_MESSAGE exists"
  
  # 에러 메시지에 'Invalid'가 포함되어야 함
  - "js: errmsg.includes('Invalid')"
  
  # 대소문자 상관없이 포함 검사
  - "js: errmsg.toLowerCase().includes('invalid')"
  
  # 여러 단어 중 하나라도 포함되면 통과
  - "js: errmsg.includes('Invalid') || errmsg.includes('Error') || errmsg.includes('Failed')"
```

#### 예제 5: 시간 기반 조건

```yaml
# 상황: 업무시간(9시-18시)에만 엄격하게 검증하고 싶음
test:
  - "RESULT_CODE exists"
  
  # 현재 시간이 9시 이전이거나 18시 이후면 관대하게, 아니면 엄격하게
  - "js: new Date().getHours() < 9 || new Date().getHours() >= 18 || result == '0'"
  
  # 설명:
  # - new Date().getHours() → 현재 시간(0~23)
  # - 9시 이전이면 통과 OR 18시 이후면 통과 OR 성공이면 통과
```

#### 예제 6: 숫자 범위 검사

```yaml
# 상황: 응답 시간이 적절한 범위인지 확인하고 싶음
extract:
  - name: "responseTime"
    pattern: "ResponseTime=([0-9]+)"
    variable: "RESPONSE_TIME"

test:
  - "RESPONSE_TIME exists"
  
  # 응답시간이 0초 초과 30초 미만의 범위에 위치해야 함
  - "js: Number(responsetime) > 0 && Number(responsetime) < 30000"
  
  # 설명:
  # - Number(responsetime) → 문자열을 숫자로 변환
  # - > 0 → 0보다 크고
  # - < 30000 → 30000(30초)보다 작아야 함
```

### 🚨 자주하는 실수들과 해결법

#### 실수 1: 존재 확인 없이 바로 JavaScript 사용
```yaml
# ❌ 잘못된 예
test:
  - "js: result == '0'"  # result가 없으면 에러!

# ✅ 올바른 예  
test:
  - "RESULT_CODE exists"  # 먼저 존재 확인
  - "js: result == '0'"   # 그 다음 JavaScript
```

#### 실수 2: 숫자와 문자열 비교 실수
```yaml
# ❌ 잘못된 예
test:
  - "js: result == 0"     # 숫자 0으로 비교 (안됨!)

# ✅ 올바른 예
test:
  - "js: result == '0'"   # 문자열 '0'으로 비교
```

#### 실수 3: 변수명 대소문자 실수
```yaml
# extract에서 이렇게 정의했다면:
extract:
  - variable: "RESULT_CODE"      # 대문자
  - variable: "SERVER_INFO"      # 대문자

# JavaScript에서는 이렇게 사용:
test:
  - "js: result == '0'"          # 소문자!
  - "js: serverinfo.length > 0"  # 소문자이고 언더스코어 없음!
```

#### 실수 4: 괄호 잘못 사용
```yaml
# ❌ 잘못된 예
test:
  - "js: result == '0' && serverinfo || result != '0' && errmsg"
  # 이렇게 쓰면 의도와 다르게 동작할 수 있음!

# ✅ 올바른 예
test:
  - "js: (result == '0' && serverinfo) || (result != '0' && errmsg)"
  # 괄호로 우선순위를 명확하게!
```

### 📝 JavaScript 테스트 작성 체크리스트

#### 1단계: 기본 준비
- [ ] extract 섹션에서 필요한 변수들을 추출했는가?
- [ ] 각 변수의 JavaScript 이름을 확인했는가? (대문자→소문자, 언더스코어 제거)

#### 2단계: 기본 테스트 작성
- [ ] 기본 존재 확인 테스트를 먼저 작성했는가?
- [ ] 간단한 JavaScript 조건부터 시작했는가?

#### 3단계: 조건 확장
- [ ] OR 조건이 필요하면 `||` 사용
- [ ] AND 조건이 필요하면 `&&` 사용  
- [ ] 복잡한 조건은 괄호 `()` 사용

#### 4단계: 테스트
- [ ] 실제로 테스트해보고 의도대로 동작하는가?
- [ ] 에러 메시지를 보고 문제점 파악했는가?

### 🎓 연습 문제

아래 상황들을 JavaScript로 어떻게 테스트할지 생각해보세요:

#### 연습 1
"result가 0이면 성공, 아니면 errmsg에 'timeout'이 포함되어야 함"

<details>
<summary>정답 보기</summary>

```yaml
test:
  - "RESULT_CODE exists"
  - "ERROR_MESSAGE exists"
  - "js: result == '0' || errmsg.toLowerCase().includes('timeout')"
```
</details>

#### 연습 2  
"업무시간(9-17시)에는 result가 0이어야 하고, 그 외 시간에는 0이나 3 허용"

<details>
<summary>정답 보기</summary>

```yaml
test:
  - "RESULT_CODE exists"
  - "js: (new Date().getHours() >= 9 && new Date().getHours() < 17) ? result == '0' : (result == '0' || result == '3')"
```
</details>

이제 JavaScript 조건부 테스트를 자신있게 작성할 수 있을 거예요! 🚀

### 7. 복합 조건 테스트 (기본)
```yaml
test:
  # 성공 케이스 전체 확인
  - "result exists"
  - "result == 0"
  - "authKey exists"
  - "authKey contains 'DN'"
  - "errMsg not contains 'ERROR'"
  
  # 실패 케이스 확인
  - "result exists"
  - "result == -1"
  - "errMsg exists"
  - "errMsg contains 'Invalid'"
```

### 테스트 작성 모범 사례

#### ✅ 좋은 테스트 예제
```yaml
test:
  # 1. 먼저 존재 확인
  - "result exists"
  - "authKey exists"
  
  # 2. 값 검증
  - "result == 0"
  - "authKey contains 'DN'"
  
  # 3. 에러 없음 확인
  - "errMsg not contains 'ERROR'"
  - "errMsg not contains 'FAIL'"
  
  # 4. 성능 확인
  - "responseTime < 5000"
```

#### ❌ 나쁜 테스트 예제
```yaml
test:
  # 존재 확인 없이 바로 값 검증 (에러 가능성)
  - "result == 0"
  
  # 너무 관대한 조건
  - "result != -999999"
  
  # 의미 없는 테스트
  - "authKey exists"  # 사용하지 않는 값의 존재만 확인
```

---

## ⚙️ Options 섹션

### 기본 옵션 구조
```yaml
options:
  stopOnError: true/false    # 에러 시 중단 여부
  timeout: 30000            # 타임아웃 (밀리초)
  retryCount: 0             # 재시도 횟수
```

### 옵션 상세 설명

#### stopOnError
```yaml
options:
  stopOnError: true    # 첫 번째 실패 시 즉시 중단
  stopOnError: false   # 모든 단계 실행 (기본값)
```

**사용 시나리오:**
- `true`: 중요한 인증이나 초기 연결 테스트
- `false`: 에러 케이스 테스트, 완전성 검사

#### timeout
```yaml
options:
  timeout: 5000     # 5초 (빠른 테스트)
  timeout: 30000    # 30초 (기본값)
  timeout: 60000    # 60초 (복잡한 플로우)
  timeout: 120000   # 2분 (매우 복잡한 프로세스)
```

#### retryCount
```yaml
options:
  retryCount: 0     # 재시도 없음 (기본값)
  retryCount: 1     # 1회 재시도
  retryCount: 3     # 3회 재시도 (네트워크 불안정 환경)
```

### 시나리오별 권장 옵션

#### 1. 기본 연결 테스트
```yaml
options:
  stopOnError: true     # 연결 실패 시 중단
  timeout: 15000       # 15초
  retryCount: 1        # 1회 재시도
```

#### 2. 완전한 결제 플로우
```yaml
options:
  stopOnError: true     # 단계별 의존성이 있음
  timeout: 60000       # 충분한 시간
  retryCount: 0        # 중복 결제 방지
```

#### 3. 에러 케이스 테스트
```yaml
options:
  stopOnError: false    # 모든 에러 케이스 확인
  timeout: 10000       # 빠른 실패
  retryCount: 0        # 재시도 없음
```

#### 4. 성능 테스트
```yaml
options:
  stopOnError: false    # 성능 데이터 수집
  timeout: 5000        # 엄격한 타임아웃
  retryCount: 0        # 정확한 성능 측정
```

---

## 🛠️ SClient 명령어 레퍼런스

### 1. CONNECT - 연결 테스트
```yaml
- name: "서버 연결 확인"
  command: "CONNECT"
  args:
    SERVICE: "{{SERVICE_NAME}}"
    ID: "{{MERCHANT_ID}}"
    PWD: "{{MERCHANT_PWD}}"
    IP: "{{SERVER_IP}}"        # 선택
    PORT: "{{SERVER_PORT}}"    # 선택
    TIMEOUT: "5000"           # 선택
```

**주요 응답 패턴:**
```yaml
extract:
  - name: "connection_result"
    pattern: "Result=([0-9-]+)"
    variable: "CONN_RESULT"
  - name: "server_status"
    pattern: "ServerStatus=([A-Za-z]+)"
    variable: "SERVER_STATUS"
```

### 2. AUTH - 인증 테스트
```yaml
- name: "상점 인증"
  command: "AUTH"
  args:
    SERVICE: "{{SERVICE_NAME}}"
    ID: "{{MERCHANT_ID}}"
    PWD: "{{MERCHANT_PWD}}"
    AUTHTYPE: "MERCHANT"      # MERCHANT, USER, ADMIN
```

**주요 응답 패턴:**
```yaml
extract:
  - name: "auth_result"
    pattern: "AuthResult=([0-9-]+)"
    variable: "AUTH_RESULT"
  - name: "auth_token"
    pattern: "AuthToken=([A-Za-z0-9]+)"
    variable: "AUTH_TOKEN"
```

### 3. ITEMSEND2 - 결제 요청
```yaml
- name: "결제 요청"
  command: "ITEMSEND2"
  args:
    # 필수 파라미터
    SERVICE: "{{SERVICE_NAME}}"
    ID: "{{MERCHANT_ID}}"
    PWD: "{{MERCHANT_PWD}}"
    ItemType: "Amount"                    # Amount, Count
    ItemCount: "1"
    ItemInfo: "2|{{AMOUNT}}|1|{{ITEM_CODE}}|{{ITEM_NAME}}"
    
    # 선택 파라미터
    Configure: "FAILURE"                  # SUCCESS, FAILURE
    OUTPUTOPTION: "DEFAULT"               # DEFAULT, XML, JSON
    IFVERSION: "V1.1.8"                  # 인터페이스 버전
    SUBCP: "{{SUBCP_CODE}}"              # 서브 CP 코드
    USERID: "{{USER_ID}}"                # 사용자 ID
    ORDERID: "{{ORDER_ID}}"              # 주문 ID
    EMAIL: "{{USER_EMAIL}}"              # 이메일
    IsPreOtbill: "N"                     # Y, N
    IsOpenMarket: "N"                    # Y, N
    IsSubscript: "N"                     # Y, N
    SellerName: "{{SELLER_NAME}}"        # 판매자명
    SellerTel: "{{SELLER_TEL}}"          # 판매자 전화
```

**주요 응답 패턴:**
```yaml
extract:
  - name: "payment_result"
    pattern: "Result=([0-9-]+)"
    variable: "PAY_RESULT"
  - name: "auth_key"
    pattern: "AuthKey=([A-Za-z0-9]+)"
    variable: "AUTH_KEY"
  - name: "transaction_id"
    pattern: "TID=([A-Za-z0-9]+)"
    variable: "TID"
  - name: "server_info"
    pattern: "ServerInfo=([A-Fa-f0-9]+)"
    variable: "SERVER_INFO"
```

### 4. DELIVER - 결제 승인
```yaml
- name: "결제 승인"
  command: "DELIVER"
  args:
    SERVICE: "{{SERVICE_NAME}}"
    ID: "{{MERCHANT_ID}}"
    PWD: "{{MERCHANT_PWD}}"
    AUTHKEY: "{{AUTH_KEY}}"              # ITEMSEND2에서 받은 키
    TID: "{{TID}}"                       # 거래 ID
    ORDERID: "{{ORDER_ID}}"              # 주문 ID
    EMAIL: "{{USER_EMAIL}}"              # 이메일
```

### 5. CONFIRM - 결제 확정
```yaml
- name: "결제 확정"
  command: "CONFIRM"
  args:
    SERVICE: "{{SERVICE_NAME}}"
    ID: "{{MERCHANT_ID}}"
    PWD: "{{MERCHANT_PWD}}"
    TID: "{{TID}}"                       # 거래 ID
    ORDERID: "{{ORDER_ID}}"              # 주문 ID
    AMOUNT: "{{AMOUNT}}"                 # 확정 금액
```

### 6. BILL - 결제 완료 확인
```yaml
- name: "결제 완료 확인"
  command: "BILL"
  args:
    SERVICE: "{{SERVICE_NAME}}"
    ID: "{{MERCHANT_ID}}"
    PWD: "{{MERCHANT_PWD}}"
    TID: "{{CONFIRM_TID}}"               # 확정된 거래 ID
    ORDERID: "{{ORDER_ID}}"              # 주문 ID
```

### 7. CANCEL - 결제 취소
```yaml
- name: "결제 취소"
  command: "CANCEL"
  args:
    SERVICE: "{{SERVICE_NAME}}"
    ID: "{{MERCHANT_ID}}"
    PWD: "{{MERCHANT_PWD}}"
    TID: "{{TID}}"                       # 취소할 거래 ID
    ORDERID: "{{ORDER_ID}}"              # 주문 ID
    CANCELREASON: "{{CANCEL_REASON}}"    # 취소 사유
    AMOUNT: "{{CANCEL_AMOUNT}}"          # 취소 금액 (부분취소 시)
```

---

## 💡 실전 예제

### 예제 1: 단순 연결 테스트
```yaml
name: "단순 연결 테스트"
description: "SClient 서버 연결 상태만 확인"
version: "1.0.0"

variables:
  MERCHANT_ID: "A010002002"
  MERCHANT_PWD: "bbbbb"
  SERVICE_NAME: "TELEDIT"

steps:
  - name: "서버 연결 확인"
    description: "기본 서버 연결 상태 점검"
    command: "CONNECT"
    args:
      SERVICE: "{{SERVICE_NAME}}"
      ID: "{{MERCHANT_ID}}"
      PWD: "{{MERCHANT_PWD}}"
    
    extract:
      - name: "connection_result"
        pattern: "Result=([0-9-]+)"
        variable: "RESULT"
    
    test:
      - "connection_result exists"
      - "RESULT == 0"

options:
  stopOnError: true
  timeout: 10000
  retryCount: 1
```

### 예제 2: 다단계 결제 플로우
```yaml
name: "완전한 결제 플로우"
description: "결제 요청부터 완료까지 전체 프로세스"
version: "1.0.0"

variables:
  MERCHANT_ID: "A010002002"
  MERCHANT_PWD: "bbbbb"
  SERVICE_NAME: "TELEDIT"
  ORDER_ID: "ORDER_{{timestamp}}"
  AMOUNT: "1000"
  USER_EMAIL: "test@danal.co.kr"

steps:
  # 1단계: 결제 요청
  - name: "결제 요청 전송"
    command: "ITEMSEND2"
    args:
      SERVICE: "{{SERVICE_NAME}}"
      ID: "{{MERCHANT_ID}}"
      PWD: "{{MERCHANT_PWD}}"
      ItemType: "Amount"
      ItemCount: "1"
      ItemInfo: "2|{{AMOUNT}}|1|22S0HZ0100|테스트상품"
      ORDERID: "{{ORDER_ID}}"
      EMAIL: "{{USER_EMAIL}}"
      IFVERSION: "V1.1.8"
    
    extract:
      # ✅ 새로운 간단한 방식 (2025-08-27)
      - name: "result"
        pattern: "Result"
        variable: "PAY_RESULT"
      - name: "authKey"
        pattern: "AuthKey"
        variable: "AUTH_KEY"
      - name: "tid"
        pattern: "TID"
        variable: "TRANSACTION_ID"
    
    test:
      - "PAY_RESULT exists"
      - "PAY_RESULT == 0"
      - "AUTH_KEY exists"
      - "TRANSACTION_ID exists"

  # 2단계: 결제 승인
  - name: "결제 승인 처리"
    command: "DELIVER"
    args:
      SERVICE: "{{SERVICE_NAME}}"
      ID: "{{MERCHANT_ID}}"
      PWD: "{{MERCHANT_PWD}}"
      AUTHKEY: "{{AUTH_KEY}}"
      TID: "{{TID}}"
      ORDERID: "{{ORDER_ID}}"
      EMAIL: "{{USER_EMAIL}}"
    
    extract:
      - name: "deliver_result"
        pattern: "Result=([0-9-]+)"
        variable: "DELIVER_RESULT"
    
    test:
      - "deliver_result exists"
      - "DELIVER_RESULT == 0"

  # 3단계: 결제 확정
  - name: "결제 확정"
    command: "CONFIRM"
    args:
      SERVICE: "{{SERVICE_NAME}}"
      ID: "{{MERCHANT_ID}}"
      PWD: "{{MERCHANT_PWD}}"
      TID: "{{TID}}"
      ORDERID: "{{ORDER_ID}}"
      AMOUNT: "{{AMOUNT}}"
    
    extract:
      - name: "confirm_result"
        pattern: "Result=([0-9-]+)"
        variable: "CONFIRM_RESULT"
      - name: "confirm_tid"
        pattern: "ConfirmTID=([A-Za-z0-9]+)"
        variable: "CONFIRM_TID"
    
    test:
      - "confirm_result exists"
      - "CONFIRM_RESULT == 0"
      - "confirm_tid exists"

options:
  stopOnError: true
  timeout: 60000
  retryCount: 0
```

### 예제 3: 에러 케이스 검증
```yaml
name: "에러 케이스 검증"
description: "다양한 실패 시나리오 테스트"
version: "1.0.0"

variables:
  VALID_ID: "A010002002"
  INVALID_ID: "INVALID123"
  VALID_PWD: "bbbbb"
  INVALID_PWD: "wrongpwd"
  SERVICE_NAME: "TELEDIT"

steps:
  # 잘못된 ID 테스트
  - name: "잘못된 상점ID 테스트"
    command: "AUTH"
    args:
      SERVICE: "{{SERVICE_NAME}}"
      ID: "{{INVALID_ID}}"
      PWD: "{{VALID_PWD}}"
    
    extract:
      - name: "invalid_id_result"
        pattern: "Result=([0-9-]+)"
        variable: "INVALID_ID_RESULT"
      - name: "error_message"
        pattern: "ErrMsg=(.+?)[\r\n]"
        variable: "ERROR_MSG"
    
    test:
      - "invalid_id_result exists"
      - "INVALID_ID_RESULT == -1"
      - "error_message exists"
      - "ERROR_MSG contains 'ID'"

  # 잘못된 비밀번호 테스트
  - name: "잘못된 비밀번호 테스트"
    command: "AUTH"
    args:
      SERVICE: "{{SERVICE_NAME}}"
      ID: "{{VALID_ID}}"
      PWD: "{{INVALID_PWD}}"
    
    extract:
      - name: "invalid_pwd_result"
        pattern: "Result=([0-9-]+)"
        variable: "INVALID_PWD_RESULT"
      - name: "pwd_error_msg"
        pattern: "ErrMsg=(.+?)[\r\n]"
        variable: "PWD_ERROR_MSG"
    
    test:
      - "invalid_pwd_result exists"
      - "INVALID_PWD_RESULT == -1"
      - "pwd_error_msg exists"
      - "PWD_ERROR_MSG contains 'PASSWORD'"

  # 정상 케이스 (비교용)
  - name: "정상 인증 확인"
    command: "AUTH"
    args:
      SERVICE: "{{SERVICE_NAME}}"
      ID: "{{VALID_ID}}"
      PWD: "{{VALID_PWD}}"
    
    extract:
      - name: "valid_result"
        pattern: "Result=([0-9-]+)"
        variable: "VALID_RESULT"
    
    test:
      - "valid_result exists"
      - "VALID_RESULT == 0"

options:
  stopOnError: false  # 모든 에러 케이스 확인
  timeout: 15000
  retryCount: 0
```

---

## 🐛 디버깅 가이드

### 최근 해결된 문제들 (2025-08-27)

#### 1. 변수 추출 실패 문제
```yaml
# 🚨 문제: 변수가 추출되었는데 테스트에서 실패
# 원인: PM 객체에 추출된 변수가 누락됨

# ✅ 해결: sclient-engine.js에서 PM 객체 매핑 개선
# 더이상 복잡한 변수 매핑 불필요, 단순 소문자 변환
```

#### 2. CAP 필드 추출 실패
```yaml
# 🚨 문제: CAP 필드가 있는데 추출 안됨  
extract:
  - name: "cap"
    pattern: "CAP"              # 대문자로 검색
    variable: "CAP_CODE"

# ✅ 해결: 대소문자 무관 검색으로 개선
# 이제 CAP/cap 모두 자동 인식
```

#### 3. 복잡한 정규식 실수
```yaml
# 🚨 문제: 정규식 작성 실수로 추출 실패
extract:
  - name: "result"
    pattern: "Result\\s*=\\s*([0-9-]+)"  # 복잡하고 실수하기 쉬움

# ✅ 해결: 간단한 키워드 방식 도입
extract:
  - name: "result"  
    pattern: "Result"            # 간단하고 안전함!
```

### 일반적인 오류와 해결책

#### 1. YAML 구문 오류
```yaml
# ❌ 잘못된 예
steps:
- name: "테스트"  # 들여쓰기 오류
  command: "AUTH"
  
# ✅ 올바른 예  
steps:
  - name: "테스트"  # 정확한 들여쓰기
    command: "AUTH"
```

#### 2. 변수 참조 오류
```yaml
# ❌ 잘못된 예
args:
  ID: MERCHANT_ID     # 중괄호 없음
  PWD: {MERCHANT_PWD} # 잘못된 문법

# ✅ 올바른 예
args:
  ID: "{{MERCHANT_ID}}"
  PWD: "{{MERCHANT_PWD}}"
```

#### 3. 정규표현식 오류
```yaml
# ❌ 잘못된 예 (이스케이프 누락)
extract:
  - name: "result"
    pattern: "Result=([0-9]+)"  # 숫자만, 음수 불가
    
# ✅ 올바른 예
extract:
  - name: "result"
    pattern: "Result=([0-9-]+)"  # 음수 포함
```

#### 4. 테스트 조건 오류
```yaml
# ❌ 잘못된 예
test:
  - "RESULT == 0"  # 변수가 추출되지 않았을 수 있음

# ✅ 올바른 예
test:
  - "result exists"  # 먼저 존재 확인
  - "RESULT == 0"    # 그 다음 값 확인
```

### 디버깅 팁

#### 1. 단계별 확인
```yaml
# 각 단계마다 추출된 변수 확인
extract:
  - name: "debug_full_response"
    pattern: "(.*)"
    variable: "FULL_RESPONSE"

test:
  - "debug_full_response exists"
  # 이후 FULL_RESPONSE 변수로 전체 응답 내용 확인 가능
```

#### 2. 로그 활용
- 실행 로그에서 `[EXTRACT FAILED]` 메시지 확인
- `[TEST PASS]` / `[TEST FAIL]` 메시지로 테스트 결과 확인
- 실제 SClient 응답 내용 확인

#### 3. 점진적 개발
```yaml
# 1단계: 기본 연결만 테스트
steps:
  - name: "연결 테스트"
    command: "CONNECT"
    # ... 기본 설정

# 2단계: 인증 추가
steps:
  - name: "연결 테스트"
    # ... 위와 동일
  - name: "인증 테스트"
    command: "AUTH"
    # ... 인증 설정

# 3단계: 전체 플로우 완성
# ...
```

---

## 🏆 모범 사례

### 1. 파일 구조
```
sample/
├── basic/
│   ├── connection_test.yaml
│   ├── auth_test.yaml
│   └── simple_payment.yaml
├── advanced/
│   ├── full_payment_flow.yaml
│   ├── subscription_test.yaml
│   └── batch_payment.yaml
├── error_cases/
│   ├── invalid_auth.yaml
│   ├── network_timeout.yaml
│   └── parameter_validation.yaml
└── performance/
    ├── load_test.yaml
    └── stress_test.yaml
```

### 2. 명명 규칙

#### 파일명
- **snake_case** 사용: `payment_flow_test.yaml`
- **의미 있는 이름**: `basic_connection.yaml`
- **카테고리 포함**: `error_invalid_auth.yaml`

#### 변수명
- **UPPER_SNAKE_CASE**: `MERCHANT_ID`, `USER_EMAIL`
- **명확한 의미**: `AUTH_KEY` (not `KEY`)
- **일관성**: 프로젝트 전체에서 동일한 패턴

#### 단계명
- **동사 + 명사**: "결제 요청 전송", "인증 상태 확인"
- **구체적**: "상점 인증" (not "인증")
- **한국어/영어 일관성**: 프로젝트 내에서 통일

### 3. 코드 구조

#### 변수 그룹화
```yaml
variables:
  # 인증 정보
  MERCHANT_ID: "A010002002"
  MERCHANT_PWD: "bbbbb"
  SERVICE_NAME: "TELEDIT"
  
  # 사용자 정보
  USER_ID: "testuser"
  USER_EMAIL: "test@example.com"
  
  # 주문 정보
  ORDER_ID: "ORDER_{{timestamp}}"
  ITEM_CODE: "22S0HZ0100"
  ITEM_NAME: "테스트상품"
  AMOUNT: "1000"
  
  # 서버 정보
  SERVER_IP: "192.168.1.100"
  SERVER_PORT: "5505"
```

#### 일관된 추출 패턴
```yaml
# 모든 단계에서 동일한 패턴 사용
extract:
  - name: "result"
    pattern: "Result=([0-9-]+)"
    variable: "STEP1_RESULT"
  - name: "error_msg"
    pattern: "ErrMsg=(.+?)[\r\n]"
    variable: "STEP1_ERROR"
```

#### 표준 테스트 패턴
```yaml
# 표준 성공 케이스 테스트
test:
  - "result exists"
  - "STEP_RESULT == 0"
  - "error_msg not contains 'ERROR'"
  - "error_msg not contains 'FAIL'"

# 표준 실패 케이스 테스트
test:
  - "result exists"
  - "STEP_RESULT == -1"
  - "error_msg exists"
  - "error_msg contains 'Expected_Error_Type'"
```

### 4. 문서화

#### 파일 헤더
```yaml
# SClient 결제 플로우 테스트
# 목적: ITEMSEND2 → DELIVER → CONFIRM → BILL 전체 프로세스 검증
# 작성자: 개발팀
# 최종 수정: 2025-08-20
# 버전: 1.2.0
# 
# 사전 조건:
# - SClient.exe 바이너리 존재
# - 테스트 상점 계정 활성화 (A010002002)
# - 네트워크 연결 정상
#
# 예상 실행 시간: 60초
# 
name: "완전한 결제 플로우 테스트"
description: "결제 요청부터 완료 확인까지 전체 프로세스 검증"
version: "1.2.0"
```

#### 단계별 설명
```yaml
steps:
  - name: "1단계: 결제 요청 전송"
    description: |
      상품 정보를 포함한 결제 요청을 서버로 전송합니다.
      성공 시 AuthKey와 TID를 받아 다음 단계에서 사용합니다.
      
      예상 소요 시간: 5-10초
      중요 파라미터: ItemInfo, ORDERID, EMAIL
    command: "ITEMSEND2"
    # ...
```

### 5. 버전 관리

#### 시맨틱 버전 사용
```yaml
version: "1.0.0"  # 최초 버전
version: "1.0.1"  # 버그 수정
version: "1.1.0"  # 기능 추가
version: "2.0.0"  # 호환성 깨는 변경
```

#### 변경 이력 관리
```yaml
# 변경 이력:
# v1.2.0 (2025-08-20): CONFIRM 단계 추가, 에러 메시지 개선
# v1.1.0 (2025-08-15): 변수 구조 개선, 테스트 케이스 추가  
# v1.0.0 (2025-08-10): 최초 버전 생성
```

이 가이드를 참고하여 효과적이고 유지보수가 쉬운 YAML 시나리오를 작성하세요! 🚀