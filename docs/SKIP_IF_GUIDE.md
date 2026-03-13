# skip_if 조건부 실행 제어 가이드

## 개요

`skip_if`는 step 실행 후 응답값을 보고, **assertion(테스트)이나 이후 step을 건너뛸지** 결정하는 기능입니다.

> **중요**: skip_if는 SClient 실행(args) **이후**, 테스트(test) **이전**에 평가됩니다.
>
> `args 실행` → `extract 추출` → **`skip_if 평가`** → `test 실행`


---

## action 종류 한눈에 보기

| action | 현재 step | 현재 step의 test | 다음 step들 |
|---|---|---|---|
| **`skip_tests`** | 실행됨 (응답 보임) | **skip** (안 보임) | **정상 실행** |
| **`skip_remaining_steps`** | 실행됨 (응답 보임) | **skip** (안 보임) | **전부 skip** |
| **`goto_step`** | 실행됨 (응답 보임) | **skip** (안 보임) | target까지 skip, **target부터 실행** |


---

## 1. `skip_tests` — 현재 step의 assertion만 skip

**이 step은 실행하되, 테스트(assertion)만 건너뛰고 다음 step은 정상 진행**

### 언제 쓰나?

- 응답이 에러이긴 한데, 예상된 에러라서 굳이 assertion 실패로 처리하고 싶지 않을 때
- 결과값에 따라 이 step의 테스트가 의미 없을 때

### 흐름도

```
Step 1: EXPREBILL   ← 실행됨, RESULT_CODE = 531
  └ skip_if: RESULT_CODE == 531 → action: skip_tests
  └ test: RESULT_CODE == 0     ← ⏭️ skip (assertion 안 함)
  └ test: TID exists           ← ⏭️ skip (assertion 안 함)

Step 2: CANCEL      ← ▶️ 정상 실행 (skip_tests는 다음 step에 영향 없음)
  └ test: C_RESULT == 0       ← ✅ 또는 ❌ (정상 평가)

Step 3: IREPORT     ← ▶️ 정상 실행
```

### YAML 예시

```yaml
  - name: "EXPREBILL"
    args:
      Command: "EXPREBILL"
      ID: "{{MERCHANT_ID}}"
      # ...

    extract:
      - name: "result"
        pattern: "Result"
        variable: "RESULT_CODE"

    skip_if:
      - condition: "RESULT_CODE == 531"
        action: "skip_tests"
        reason: "531 인증실패는 허용 가능한 응답"

    test:
      - name: "결과 코드 정상"
        assertion: "RESULT_CODE == 0"      # ← 531이면 이 테스트 skip
      - name: "TID 존재"
        assertion: "TID exists"            # ← 531이면 이 테스트도 skip
```

### 리포트 표시

- Step 1: **표시됨** (커맨드, 응답, 추출 변수 모두 보임)
- Step 1의 assertion: **안 보임** (skip된 assertion은 리포트에서 제외)
- 통계: assertion 0개, 실패 0개 → **성공 처리**


---

## 2. `skip_remaining_steps` — 이후 step 전부 skip

**이 step 실행 후, 나머지 모든 step을 건너뜀 (시나리오 종료)**

### 언제 쓰나?

- 첫 번째 step이 실패하면 그 다음 step이 의미 없을 때 (예: 결제 실패 → 취소 불필요)
- 에러 응답이면 이후 모든 테스트를 진행할 필요가 없을 때

### 흐름도

```
Step 1: EXPREBILL   ← 실행됨, RESULT_CODE = 531
  └ skip_if: RESULT_CODE != 0 → action: skip_remaining_steps
  └ test: RESULT_CODE == 0   ← ⏭️ skip
  └ test: TID exists         ← ⏭️ skip

Step 2: CANCEL      ← ⏭️ 전체 skip (실행 안 함, 리포트에도 안 나옴)
Step 3: IREPORT     ← ⏭️ 전체 skip (실행 안 함, 리포트에도 안 나옴)

→ 시나리오 종료 (성공 처리)
```

### YAML 예시

```yaml
  - name: "EXPREBILL"
    args:
      Command: "EXPREBILL"
      # ...

    extract:
      - name: "result"
        pattern: "Result"
        variable: "RESULT_CODE"

    skip_if:
      - condition: "js: RESULT_CODE != '0' && RESULT_CODE !== undefined"
        action: "skip_remaining_steps"
        reason: "EXPREBILL 실패, 이후 CANCEL/IREPORT 불필요"

    test:
      - name: "결과 코드 정상"
        assertion: "RESULT_CODE == 0"
```

### 리포트 표시

- Step 1: **표시됨** (실행했으므로)
- Step 1의 assertion: **안 보임**
- Step 2, 3: **안 보임** (실행 안 했으므로 리포트에서 완전 제외)
- 통계: request 1개, assertion 0개, 실패 0개 → **성공 처리**


---

## 3. `goto_step` — 특정 step으로 점프

**중간 step을 건너뛰고 지정한 step부터 다시 정상 실행**

### 언제 쓰나?

- 결과값에 따라 다른 처리 흐름을 타야 할 때
- 예: 정상(0)이면 CANCEL, 531이면 531 전용 처리

### 흐름도

```
Step 1: EXPREBILL   ← 실행됨, RESULT_CODE = 531
  └ skip_if: RESULT_CODE == 531 → action: goto_step, target: "531 전용 처리"
  └ test: RESULT_CODE == 0   ← ⏭️ skip

Step 2: CANCEL      ← ⏭️ skip (target 전이므로 건너뜀)

Step 3: 531 전용 처리  ← ▶️ 실행 (goto target, 여기서부터 재개)
  └ test: ERROR_MESSAGE exists  ← ✅ 정상 평가

Step 4: 공통 마무리    ← ▶️ 실행 (target 이후이므로 계속 진행)
```

### YAML 예시

```yaml
  - name: "EXPREBILL"
    args: { ... }
    extract: { ... }

    skip_if:
      # 531이면 → 531 전용 처리로 점프
      - condition: "RESULT_CODE == 531"
        action: "goto_step"
        target: "531 전용 처리"
        reason: "531 인증실패, 전용 처리로 이동"

      # 0이 아닌 기타 에러면 → 나머지 전부 skip
      - condition: "js: RESULT_CODE != '0'"
        action: "skip_remaining_steps"
        reason: "기타 에러, 이후 테스트 불필요"

    test:
      - name: "결과 코드 정상"
        assertion: "RESULT_CODE == 0"

  - name: "CANCEL - 정상 흐름"
    # RESULT_CODE == 0일 때만 여기 실행
    args: { ... }
    test: { ... }

  - name: "531 전용 처리"
    # 531일 때 여기로 점프
    args: { ... }
    test:
      - name: "531 에러 메시지 확인"
        assertion: "ERROR_MESSAGE exists"

  - name: "공통 마무리"
    # 어떤 경로든 여기는 실행됨
    args: { ... }
```

### 주의사항

- `target` 값은 **step의 name과 정확히 일치**해야 합니다
- target step은 현재 step **이후**에 있어야 합니다 (이전 step으로 돌아갈 수 없음)
- target을 찾지 못하면 **`skip_remaining_steps`로 자동 fallback** 됩니다 (안전 처리)
- 점프 후 target step부터 **정상 실행이 계속됩니다** (target 이후 step도 모두 실행)


---

## condition 작성법

### 단순 비교

```yaml
condition: "RESULT_CODE == 0"        # 같다
condition: "RESULT_CODE != 0"        # 다르다
condition: "RESULT_CODE == 531"      # 특정 값
condition: "TID exists"              # 값이 존재하는지
```

### JavaScript 표현식 (`js:` 접두사)

```yaml
# OR 조건 (둘 중 하나)
condition: "js: RESULT_CODE == '0' || RESULT_CODE == '531'"

# AND 조건 (둘 다)
condition: "js: RESULT_CODE != '0' && RESULT_CODE !== undefined"

# 복합 조건
condition: "js: ['0', '531', '999'].includes(RESULT_CODE)"
```

> **주의**: `js:` 표현식에서 변수값은 **문자열**입니다. `== '0'` (문자열 비교) 권장.
> 단순 비교(`condition: "RESULT_CODE == 0"`)는 자동으로 문자열 변환 처리됩니다.


---

## 다중 조건 (우선순위)

여러 조건을 나열하면 **위에서부터 순서대로** 평가하고, **첫 번째 매칭**만 적용됩니다.

```yaml
    skip_if:
      # 1순위: 531이면 전용 처리로
      - condition: "RESULT_CODE == 531"
        action: "goto_step"
        target: "531 전용 처리"
        reason: "531 인증실패"

      # 2순위: 999면 전체 중단
      - condition: "RESULT_CODE == 999"
        action: "skip_remaining_steps"
        reason: "999 서비스 불가"

      # 3순위: 0이 아닌 기타 에러면 assertion만 skip
      - condition: "js: RESULT_CODE != '0'"
        action: "skip_tests"
        reason: "기타 에러 코드"
```

**배치 원칙**: 구체적인 조건 → 일반적인 조건 순서로 작성


---

## 요약 비교표

```
                     현재 step    현재 test    다음 step
                     ─────────    ─────────    ─────────
skip_tests           ▶️ 실행      ⏭️ skip      ▶️ 실행
skip_remaining_steps ▶️ 실행      ⏭️ skip      ⏭️ 전부 skip
goto_step            ▶️ 실행      ⏭️ skip      ⏭️→▶️ target부터 실행
조건 불일치          ▶️ 실행      ▶️ 실행      ▶️ 실행
```

> 모든 경우에 **현재 step 자체는 항상 실행**됩니다 (커맨드, 응답, 변수 추출).
> skip되는 것은 **assertion(test)과 이후 step**뿐입니다.


---

## 4. `run_if` — 블럭 단위 조건부 Assertion

**test 섹션 안에서 여러 assertion을 하나의 조건으로 묶어 실행**

### skip_if vs run_if 차이

| 기능 | `skip_if` | `run_if` |
|---|---|---|
| **위치** | step 레벨 (test와 같은 indent) | test 블럭 내부 |
| **범위** | step 전체의 모든 assertion | 블럭 내 assertion만 |
| **동작** | 조건 true → assertion **skip** | 조건 true → assertion **실행** |
| **목적** | 에러 시 테스트 전체 건너뛰기 | 결과값에 따라 다른 검증 실행 |

### 언제 쓰나?

- 같은 step에서 결과값에 따라 **다른 assertion**을 실행하고 싶을 때
- 예: 성공(0)이면 TID 검증, 실패(531)이면 에러 메시지 검증

### 흐름도

```
Step 1: EXPREBILL   ← 실행됨, RESULT_CODE = 0

  test:
    "RESULT_CODE exists"          ← ✅ 항상 실행

    run_if: "RESULT_CODE == 0"    ← 조건 true
      "TID exists"                ← ✅ 실행
      "RESULT_CODE == 0"          ← ✅ 실행

    run_if: "RESULT_CODE != 0"    ← 조건 false
      "ERROR_MESSAGE exists"      ← ⏭️ skip (리포트 제외)

    "결과 존재 확인"              ← ✅ 항상 실행
```

### YAML 문법

```yaml
  - name: "EXPREBILL"
    args:
      Command: "EXPREBILL"
      # ...

    extract:
      - name: "result"
        pattern: "Result"
        variable: "RESULT_CODE"
      - name: "tid"
        pattern: "TID"
        variable: "TID"
      - name: "errMsg"
        pattern: "ErrMsg"
        variable: "ERROR_MESSAGE"

    test:
      # 일반 assertion (항상 실행)
      - "RESULT_CODE exists"

      # 성공(0)일 때만 실행하는 블럭
      - run_if: "RESULT_CODE == 0"
        assertions:
          - name: "TID 존재 확인"
            assertion: "TID exists"
          - name: "결과 코드 정상"
            assertion: "RESULT_CODE == 0"
          - "ERROR_MESSAGE exists"

      # 실패(0이 아닐 때)만 실행하는 블럭
      - run_if: "RESULT_CODE != 0"
        assertions:
          - name: "에러 메시지 확인"
            assertion: "ERROR_MESSAGE exists"

      # 일반 assertion (항상 실행)
      - name: "결과 존재 확인"
        assertion: "RESULT_CODE exists"
```

### indent 구조

```
test:                                # indent 4
  - run_if: "RESULT_CODE == 0"      # indent 6 → 블럭 헤더
    assertions:                      # indent 8 → 블럭 assertion 리스트 키
      - name: "TID 존재"            # indent 10 → 블럭 내 assertion (객체)
        assertion: "TID exists"      # indent 12 → 블럭 assertion 속성
      - "SERVER_INFO exists"         # indent 10 → 블럭 내 assertion (단순)
  - name: "항상 실행"                # indent 6 → 일반 test (블럭 밖)
    assertion: "RESULT_CODE exists"  # indent 8
```

### 조건식 문법

`skip_if`의 `condition`과 동일한 문법 사용:

```yaml
# 단순 비교
- run_if: "RESULT_CODE == 0"
- run_if: "RESULT_CODE != 0"
- run_if: "TID exists"

# JavaScript 표현식
- run_if: "js: RESULT_CODE == '0' || RESULT_CODE == '3'"
- run_if: "js: parseInt(RESULT_CODE) >= 500"
```

### 리포트 동작

- `run_if` 조건 **true** → 블럭 내 assertion 정상 실행 (pass/fail 판정)
- `run_if` 조건 **false** → 블럭 내 assertion 전부 skip
  - skip된 assertion: **리포트에서 제외, 통계 미포함**
- 일반 assertion (블럭 밖): **항상 실행**

### skip_if + run_if 조합 사용

같은 step에서 `skip_if`와 `run_if`를 함께 사용할 수 있습니다.
`skip_if`가 먼저 평가되고, skip되지 않은 경우에만 `run_if`가 평가됩니다.

```yaml
  - name: "EXPREBILL"
    args: { ... }
    extract: { ... }

    # 1단계: skip_if 평가 (step 레벨)
    skip_if:
      - condition: "RESULT_CODE == 999"
        action: "skip_remaining_steps"
        reason: "서비스 불가"

    # 2단계: test 실행 (skip_if가 매칭 안 됐을 때만)
    test:
      - "RESULT_CODE exists"        # 항상 실행

      - run_if: "RESULT_CODE == 0"  # 성공 시에만
        assertions:
          - "TID exists"
          - "RESULT_CODE == 0"

      - run_if: "RESULT_CODE != 0"  # 에러 시에만
        assertions:
          - "ERROR_MESSAGE exists"
```
