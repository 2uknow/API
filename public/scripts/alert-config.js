        // 다크모드 관련 함수들
        function initTheme() {
            const savedTheme = localStorage.getItem('theme') || 'light';
            setTheme(savedTheme);
            
            // 토글 버튼 이벤트 리스너
            document.getElementById('themeToggle').addEventListener('click', toggleTheme);
        }

        function setTheme(theme) {
            if (theme === 'dark') {
                document.documentElement.setAttribute('data-theme', 'dark');
                updateThemeIcon('dark');
            } else {
                document.documentElement.removeAttribute('data-theme');
                updateThemeIcon('light');
            }
            localStorage.setItem('theme', theme);
        }

        function toggleTheme() {
            const currentTheme = document.documentElement.getAttribute('data-theme');
            const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
            setTheme(newTheme);
        }

        function updateThemeIcon(theme) {
            const themeIcon = document.getElementById('themeIcon');
            if (theme === 'dark') {
                // 달 모양 아이콘 (다크모드)
                themeIcon.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"></path>';
            } else {
                // 태양 모양 아이콘 (라이트모드)
                themeIcon.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"></path>';
            }
        }

        // 현재 설정 로드
        async function loadCurrentConfig() {
            try {
                const response = await fetch('/api/alert/config');
                const config = await response.json();

                // 현재 상태 표시
                updateStatusDisplay(config);

                // 폼 필드 설정
                document.getElementById('run_event_alert').checked = config.run_event_alert;
                document.getElementById('alert_on_start').checked = config.alert_on_start;
                document.getElementById('alert_on_success').checked = config.alert_on_success;
                document.getElementById('alert_on_error').checked = config.alert_on_error;

                const methodRadio = document.querySelector(`input[name="alert_method"][value="${config.alert_method}"]`);
                if (methodRadio) methodRadio.checked = true;

                // 상세 설정 활성화/비활성화
                toggleDetailSettings(config.run_event_alert);

                // 정기 리포트 설정 로드
                document.getElementById('daily_report_enabled').checked = config.daily_report_enabled;

                // 시간 목록 로드
                const times = config.daily_report_times || ['18:00'];
                renderTimesList(times);

                // 요일 체크박스 설정
                const days = config.daily_report_days || [1, 2, 3, 4, 5];
                document.querySelectorAll('input[name="daily_report_days"]').forEach(cb => {
                    cb.checked = days.includes(parseInt(cb.value));
                });

                // 정기 리포트 상세 설정 활성화/비활성화
                toggleDailyReportSettings(config.daily_report_enabled);
                // 웹훅 URL 로드
                const webhookRes = await fetch('/api/alert/webhook-url');
                const webhookData = await webhookRes.json();
                document.getElementById('webhook_url_input').value = webhookData.webhook_url || '';
            } catch (error) {
                showNotification('설정을 불러오는 중 오류가 발생했습니다.', 'error');
            }
        }

        // 상태 표시 업데이트
        function updateStatusDisplay(config) {
            const statusContainer = document.getElementById('currentStatus');
            statusContainer.innerHTML = `
                <div class="flex items-center justify-between p-4 rounded-xl border bg-sec-var bd-c">
                    <span class="text-sm font-semibold t-pri">알람 시스템</span>
                    <span class="px-3 py-1.5 text-sm rounded-full font-medium ${config.run_event_alert ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}">
                        ${config.run_event_alert ? '활성화' : '비활성화'}
                    </span>
                </div>
                <div class="flex items-center justify-between p-4 rounded-xl border bg-sec-var bd-c">
                    <span class="text-sm font-semibold t-pri">웹훅 URL</span>
                    <span class="px-3 py-1.5 text-sm rounded-full font-medium ${config.webhook_url === '설정됨' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}">
                        ${config.webhook_url}
                    </span>
                </div>
                <div class="flex items-center justify-between p-4 rounded-xl border bg-sec-var bd-c">
                    <span class="text-sm font-semibold t-pri">알람 방식</span>
                    <span class="px-3 py-1.5 text-sm bg-blue-100 text-blue-800 rounded-full font-medium">
                        ${config.alert_method === 'flex' ? 'Flex 메시지' : '텍스트 메시지'}
                    </span>
                </div>
                <div class="flex items-center justify-between p-4 rounded-xl border bg-sec-var bd-c">
                    <span class="text-sm font-semibold t-pri">활성화된 알람</span>
                    <span class="text-sm font-medium t-sec">
                        ${[
                            config.alert_on_start && '실행 시작 시',
                            config.alert_on_success && '실행 성공 시',
                            config.alert_on_error && '실행 실패 시'
                        ].filter(Boolean).join(', ') || '없음'}
                    </span>
                </div>
            `;
        }

        // 상세 설정 토글
        function toggleDetailSettings(enabled) {
            const detailSettings = document.getElementById('detailSettings');
            if (enabled) {
                detailSettings.classList.remove('opacity-50', 'pointer-events-none');
            } else {
                detailSettings.classList.add('opacity-50', 'pointer-events-none');
            }
        }

        // 정기 리포트 설정 토글
        function toggleDailyReportSettings(enabled) {
            const settings = document.getElementById('dailyReportSettings');
            if (enabled) {
                settings.classList.remove('opacity-50', 'pointer-events-none');
            } else {
                settings.classList.add('opacity-50', 'pointer-events-none');
            }
        }

        // 시간 옵션 생성
        function generateHourOptions(selectedHour) {
            let options = '';
            for (let h = 0; h < 24; h++) {
                const hour = h.toString().padStart(2, '0');
                const label = h < 12 ? `오전 ${h === 0 ? 12 : h}시` : `오후 ${h === 12 ? 12 : h - 12}시`;
                options += `<option value="${hour}" ${hour === selectedHour ? 'selected' : ''}>${label}</option>`;
            }
            return options;
        }

        function generateMinuteOptions(selectedMinute) {
            const minutes = ['00', '15', '30', '45'];
            return minutes.map(m =>
                `<option value="${m}" ${m === selectedMinute ? 'selected' : ''}>${m}분</option>`
            ).join('');
        }

        // 시간 목록 렌더링
        function renderTimesList(times) {
            const container = document.getElementById('timesList');
            container.innerHTML = '';

            times.forEach((time, index) => {
                const [hour, minute] = time.split(':');
                const div = document.createElement('div');
                div.className = 'time-item flex items-center gap-3 p-3 rounded-xl border transition-all hover:shadow-md';
                div.style.cssText = 'background: var(--bg-tertiary); border-color: var(--border-color);';
                div.innerHTML = `
                    <div class="flex items-center gap-2 flex-1">
                        <div class="flex items-center gap-1 px-3 py-2 rounded-lg bg-blue-grad">
                            <svg class="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                            </svg>
                        </div>
                        <select class="time-hour px-3 py-2 rounded-lg border-0 font-medium cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-500 bg-sec-var t-pri">
                            ${generateHourOptions(hour)}
                        </select>
                        <span class="text-lg font-bold t-sec">:</span>
                        <select class="time-minute px-3 py-2 rounded-lg border-0 font-medium cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-500 bg-sec-var t-pri">
                            ${generateMinuteOptions(minute)}
                        </select>
                    </div>
                    <button type="button" class="remove-time-btn p-2 text-red-500 hover:bg-red-100 rounded-lg transition-all"
                        ${times.length <= 1 ? 'disabled style="opacity:0.3;cursor:not-allowed;"' : ''}>
                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                        </svg>
                    </button>
                `;
                container.appendChild(div);
            });

            // 삭제 버튼 이벤트
            container.querySelectorAll('.remove-time-btn').forEach(btn => {
                btn.addEventListener('click', function() {
                    if (container.children.length > 1) {
                        this.parentElement.remove();
                        updateRemoveButtons();
                    }
                });
            });
        }

        // 삭제 버튼 상태 업데이트
        function updateRemoveButtons() {
            const container = document.getElementById('timesList');
            const buttons = container.querySelectorAll('.remove-time-btn');
            buttons.forEach(btn => {
                if (container.children.length <= 1) {
                    btn.disabled = true;
                    btn.style.opacity = '0.3';
                    btn.style.cursor = 'not-allowed';
                } else {
                    btn.disabled = false;
                    btn.style.opacity = '1';
                    btn.style.cursor = 'pointer';
                }
            });
        }

        // 시간 추가
        function addTimeInput() {
            const container = document.getElementById('timesList');
            const div = document.createElement('div');
            div.className = 'time-item flex items-center gap-3 p-3 rounded-xl border transition-all hover:shadow-md';
            div.style.cssText = 'background: var(--bg-tertiary); border-color: var(--border-color);';
            div.innerHTML = `
                <div class="flex items-center gap-2 flex-1">
                    <div class="flex items-center gap-1 px-3 py-2 rounded-lg bg-blue-grad">
                        <svg class="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                        </svg>
                    </div>
                    <select class="time-hour px-3 py-2 rounded-lg border-0 font-medium cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-500 bg-sec-var t-pri">
                        ${generateHourOptions('18')}
                    </select>
                    <span class="text-lg font-bold t-sec">:</span>
                    <select class="time-minute px-3 py-2 rounded-lg border-0 font-medium cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-500 bg-sec-var t-pri">
                        ${generateMinuteOptions('00')}
                    </select>
                </div>
                <button type="button" class="remove-time-btn p-2 text-red-500 hover:bg-red-100 rounded-lg transition-all">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                    </svg>
                </button>
            `;
            container.appendChild(div);

            // 새로 추가된 삭제 버튼에 이벤트 연결
            div.querySelector('.remove-time-btn').addEventListener('click', function() {
                if (container.children.length > 1) {
                    div.remove();
                    updateRemoveButtons();
                }
            });

            updateRemoveButtons();
        }

        // 알림 표시
        function showNotification(message, type = 'info') {
            const notification = document.createElement('div');
            notification.className = `fixed top-4 right-4 px-6 py-3 rounded-xl text-white z-50 shadow-lg font-medium ${
                type === 'success' ? 'bg-green-500' : 
                type === 'error' ? 'bg-red-500' : 'bg-blue-500'
            }`;
            notification.textContent = message;
            
            document.body.appendChild(notification);
            
            setTimeout(() => {
                notification.remove();
            }, 3000);
        }

        // 이벤트 리스너 설정
        document.addEventListener('DOMContentLoaded', function() {
            // 다크모드 초기화를 가장 먼저 실행
            initTheme();
            loadCurrentConfig();

            // 메인 스위치 변경 시
            document.getElementById('run_event_alert').addEventListener('change', function() {
                toggleDetailSettings(this.checked);
            });

            // 정기 리포트 스위치 변경 시
            document.getElementById('daily_report_enabled').addEventListener('change', function() {
                toggleDailyReportSettings(this.checked);
            });

            // 알람 설정 폼 제출
            document.getElementById('alertConfigForm').addEventListener('submit', async function(e) {
                e.preventDefault();

                const formData = {
                    run_event_alert: document.getElementById('run_event_alert').checked,
                    alert_on_start: document.getElementById('alert_on_start').checked,
                    alert_on_success: document.getElementById('alert_on_success').checked,
                    alert_on_error: document.getElementById('alert_on_error').checked,
                    alert_method: document.querySelector('input[name="alert_method"]:checked')?.value || 'text'
                };

                try {
                    const response = await fetch('/api/alert/config', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify(formData)
                    });

                    if (response.ok) {
                        const result = await response.json();
                        showNotification('설정이 저장되었습니다.', 'success');
                        loadCurrentConfig();
                    } else {
                        const errorText = await response.text();
                        throw new Error(errorText);
                    }
                } catch (error) {
                    console.error('설정 저장 오류:', error);
                    showNotification('설정 저장 중 오류가 발생했습니다.', 'error');
                }
            });

            // 웹훅 URL 저장
            document.getElementById('webhookForm').addEventListener('submit', async function(e) {
                e.preventDefault();
                const url = document.getElementById('webhook_url_input').value.trim();
                try {
                    const response = await fetch('/api/alert/config', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ webhook_url: url })
                    });
                    if (response.ok) {
                        showNotification('웹훅 URL이 저장되었습니다.', 'success');
                        loadCurrentConfig();
                    } else {
                        throw new Error(await response.text());
                    }
                } catch (error) {
                    showNotification('저장 중 오류가 발생했습니다.', 'error');
                }
            });

            // 웹훅 테스트 전송
            document.getElementById('testAlertBtn').addEventListener('click', async function() {
                const url = document.getElementById('webhook_url_input').value.trim();
                if (!url) {
                    showNotification('웹훅 URL을 먼저 입력하고 저장해주세요.', 'error');
                    return;
                }
                this.disabled = true;
                this.textContent = '전송 중...';
                try {
                    const response = await fetch('/api/alert/test', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' }
                    });
                    const result = await response.json();
                    if (result.ok) {
                        showNotification('테스트 알람이 전송되었습니다.', 'success');
                    } else {
                        throw new Error(result.message || '전송 실패');
                    }
                } catch (error) {
                    showNotification('테스트 전송 실패: ' + error.message, 'error');
                } finally {
                    this.disabled = false;
                    this.textContent = '테스트 전송';
                }
            });

            // 시간 추가 버튼
            document.getElementById('addTimeBtn').addEventListener('click', addTimeInput);

            // 정기 리포트 폼 제출
            document.getElementById('dailyReportForm').addEventListener('submit', async function(e) {
                e.preventDefault();

                // 시간 목록 수집
                const selectedTimes = [];
                document.querySelectorAll('.time-item').forEach(item => {
                    const hour = item.querySelector('.time-hour').value;
                    const minute = item.querySelector('.time-minute').value;
                    selectedTimes.push(`${hour}:${minute}`);
                });

                // 요일 목록 수집
                const selectedDays = [];
                document.querySelectorAll('input[name="daily_report_days"]:checked').forEach(cb => {
                    selectedDays.push(parseInt(cb.value));
                });

                if (selectedTimes.length === 0) {
                    showNotification('최소 하나의 발송 시간을 입력해주세요.', 'error');
                    return;
                }

                const formData = {
                    daily_report_enabled: document.getElementById('daily_report_enabled').checked,
                    daily_report_times: selectedTimes,
                    daily_report_days: selectedDays
                };

                try {
                    const response = await fetch('/api/alert/config', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify(formData)
                    });

                    if (response.ok) {
                        showNotification('정기 리포트 설정이 저장되었습니다.', 'success');
                        loadCurrentConfig();
                    } else {
                        throw new Error(await response.text());
                    }
                } catch (error) {
                    console.error('설정 저장 오류:', error);
                    showNotification('설정 저장 중 오류가 발생했습니다.', 'error');
                }
            });

            // 테스트 발송 버튼
            document.getElementById('testDailyReport').addEventListener('click', async function() {
                this.disabled = true;
                this.textContent = '발송 중...';

                try {
                    const response = await fetch('/api/alert/daily-report/test', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        }
                    });

                    const result = await response.json();

                    if (result.ok) {
                        showNotification('테스트 리포트가 발송되었습니다.', 'success');
                    } else {
                        throw new Error(result.message || '발송 실패');
                    }
                } catch (error) {
                    console.error('테스트 발송 오류:', error);
                    showNotification('테스트 발송에 실패했습니다: ' + error.message, 'error');
                } finally {
                    this.disabled = false;
                    this.textContent = '테스트 발송';
                }
            });
        });
