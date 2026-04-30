// Newman + newman-reporter-htmlextra가 생성한 표준 HTML 리포트에
// 모바일 가독성 CSS를 주입한다.
// htmlextra는 Bootstrap 기반이라 .container/.card/.table/.nav-tabs 등을 그대로
// 사용하므로 보편적 셀렉터로 강제 override 가능하다.
//
// 추가로 모든 리포트(htmlextra 외 SClient 자체 리포트, batch summary 포함) 에
// 좌상단 "← 뒤로" 버튼을 주입해 같은 탭으로 열렸을 때 대시보드로 돌아갈 수 있게 한다.
import fs from 'fs';

const INJECT_MARKER = '<!-- newman-mobile-injected -->';
const BACK_BUTTON_MARKER = '<!-- back-button-injected -->';

const NEWMAN_MOBILE_CSS = `
${INJECT_MARKER}
<style>
@media (max-width: 767px) {
  html, body { overflow-x: hidden !important; }
  body { padding: 0 !important; margin: 0 !important; }

  /* 컨테이너 풀폭 — htmlextra의 max-width 고정 해제 */
  .container, .container-fluid, .container-xl, .container-lg, .container-md, .container-sm,
  main, .main-content {
    max-width: 100% !important;
    width: 100% !important;
    padding-left: 10px !important;
    padding-right: 10px !important;
    margin-left: 0 !important;
    margin-right: 0 !important;
  }

  /* row gutter 축소 */
  .row { margin-left: -4px !important; margin-right: -4px !important; }
  .row > [class*="col-"], .row > .col {
    padding-left: 4px !important;
    padding-right: 4px !important;
  }

  /* "Newman Run Dashboard" 같은 큰 헤더가 단어별로 줄바꿈되는 문제 */
  .display-1, .display-2, .display-3, .display-4, .display-5, .display-6 {
    font-size: 1.5rem !important;
    line-height: 1.2 !important;
    word-break: keep-all !important;
  }
  h1 { font-size: 1.3rem !important; line-height: 1.3 !important; }
  h2 { font-size: 1.15rem !important; }
  h3 { font-size: 1.05rem !important; }
  h4 { font-size: 0.95rem !important; }
  h5, h6 { font-size: 0.88rem !important; }

  /* 카드 컴팩트 */
  .card { margin-bottom: 10px !important; border-radius: 10px !important; }
  .card-body { padding: 12px !important; }
  .card-header { padding: 8px 12px !important; font-size: 0.85rem !important; font-weight: 600 !important; }
  .card-footer { padding: 8px 12px !important; }

  /* 통계 카드 안의 큰 숫자 */
  .summary-counts h1, .summary-counts h2,
  .text-center h1, .text-center h2,
  .summary-card .display-4, .summary-card .display-3 {
    font-size: 1.8rem !important;
  }
  /* htmlextra의 dashboard 큰 카드 패딩 */
  .summary-card { padding: 12px !important; }

  /* 탭 네비게이션 (Summary / Total Requests / Failed Tests / Skipped Tests) */
  .nav-tabs, .nav-pills, .nav {
    flex-wrap: wrap !important;
    gap: 4px !important;
    border-bottom: none !important;
    padding: 4px 0 !important;
  }
  .nav-tabs .nav-link, .nav-pills .nav-link, .nav .nav-link {
    padding: 6px 10px !important;
    font-size: 0.78rem !important;
    border-radius: 6px !important;
    white-space: nowrap !important;
  }
  .nav-item .badge {
    font-size: 0.7rem !important;
    padding: 2px 6px !important;
  }

  /* 다크/라이트 토글 버튼 */
  .navbar { padding: 6px 10px !important; }
  .navbar-brand { font-size: 0.95rem !important; }
  .navbar-toggler { padding: 4px 8px !important; }

  /* 테이블: 모바일은 글자 작게 + 양쪽 padding 축소 + 가로 스크롤 fallback */
  .table-responsive { overflow-x: auto !important; -webkit-overflow-scrolling: touch !important; }
  .table { font-size: 0.78rem !important; margin-bottom: 8px !important; }
  .table th, .table td {
    padding: 6px 8px !important;
    word-break: break-all !important;
    overflow-wrap: anywhere !important;
    vertical-align: middle !important;
  }
  .table th { font-size: 0.72rem !important; }

  /* 코드/pre */
  pre, code, .pre, kbd {
    font-size: 0.7rem !important;
    word-break: break-all !important;
    overflow-wrap: anywhere !important;
    white-space: pre-wrap !important;
  }
  pre { padding: 8px !important; }

  /* 버튼/뱃지 */
  .btn { padding: 6px 12px !important; font-size: 0.8rem !important; }
  .btn-sm { padding: 4px 8px !important; font-size: 0.72rem !important; }
  .badge { font-size: 0.7rem !important; padding: 3px 6px !important; }

  /* 폼 컨트롤 */
  .form-control, .form-select {
    font-size: 0.85rem !important;
    padding: 6px 10px !important;
  }

  /* 알림/경고 박스 */
  .alert { padding: 10px 12px !important; font-size: 0.8rem !important; border-radius: 8px !important; }

  /* htmlextra 특유의 dashboard hero 영역 */
  .dashboard, .dashboard-stats {
    padding: 8px !important;
  }

  /* 긴 URL/문자열이 들어가는 셀들 강제 줄바꿈 */
  td, th, .url-text, .request-url, .response-body {
    word-break: break-all !important;
    overflow-wrap: anywhere !important;
  }

  /* htmlextra navigation: 좌상단 햄버거/탭 */
  .nav-link, .navbar-nav .nav-link {
    padding: 6px 10px !important;
  }

  /* 푸터 */
  footer { padding: 10px !important; font-size: 0.75rem !important; }
}

@media (max-width: 480px) {
  .container, .container-fluid {
    padding-left: 8px !important;
    padding-right: 8px !important;
  }
  .display-1, .display-2, .display-3, .display-4 {
    font-size: 1.25rem !important;
  }
  h1 { font-size: 1.15rem !important; }
  .card-body { padding: 10px !important; }
  .summary-counts h1, .summary-counts h2,
  .text-center h1, .text-center h2 { font-size: 1.5rem !important; }
}
</style>
`;

// 뒤로가기 버튼 (모든 리포트 좌상단 fixed). history 가 비어 있으면 대시보드로.
const BACK_BUTTON_HTML = `
${BACK_BUTTON_MARKER}
<style>
  #report-back-btn {
    position: fixed; top: 12px; left: 12px; z-index: 99999;
    display: inline-flex; align-items: center; gap: 6px;
    padding: 6px 12px;
    background: #4f46e5; color: #fff; border: none; border-radius: 6px;
    font-size: 0.85rem; font-weight: 500; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    text-decoration: none; cursor: pointer;
    box-shadow: 0 2px 8px rgba(0,0,0,0.2);
    line-height: 1;
  }
  #report-back-btn:hover { background: #4338ca; color: #fff; text-decoration: none; }
  @media (max-width: 767px) {
    #report-back-btn { top: 8px; left: 8px; padding: 5px 10px; font-size: 0.8rem; }
  }
  @media print { #report-back-btn { display: none !important; } }
</style>
<a href="/" id="report-back-btn" onclick="if(history.length>1){history.back();return false;}return true;">← 뒤로</a>
`;

/**
 * Newman HTMLExtra 리포트 HTML 파일에 모바일 친화 CSS와 뒤로가기 버튼을 주입한다.
 * - 멱등성 보장 (각 marker 별로 개별 체크 — 둘 중 하나만 빠진 옛 파일도 보강)
 * - viewport meta가 없으면 추가
 * - 실패해도 원본 리포트는 보존
 */
export async function injectNewmanReportMobileStyles(htmlPath) {
  if (!htmlPath || !fs.existsSync(htmlPath)) return false;

  try {
    let html = await fs.promises.readFile(htmlPath, 'utf-8');

    const hasMobile = html.includes(INJECT_MARKER);
    const hasBack = html.includes(BACK_BUTTON_MARKER);

    // 둘 다 이미 들어 있으면 skip
    if (hasMobile && hasBack) return true;

    // viewport meta 보장
    if (!/<meta\s+[^>]*name=["']viewport["']/i.test(html)) {
      html = html.replace(
        /<head([^>]*)>/i,
        '<head$1>\n<meta name="viewport" content="width=device-width, initial-scale=1.0">'
      );
    }

    // </head> 직전에 모바일 CSS 주입
    if (!hasMobile) {
      if (/<\/head>/i.test(html)) {
        html = html.replace(/<\/head>/i, `${NEWMAN_MOBILE_CSS}\n</head>`);
      } else {
        html = NEWMAN_MOBILE_CSS + html;
      }
    }

    // <body> 직후 뒤로가기 버튼 주입
    if (!hasBack) {
      if (/<body[^>]*>/i.test(html)) {
        html = html.replace(/<body([^>]*)>/i, `<body$1>${BACK_BUTTON_HTML}`);
      } else {
        // <body> 가 없는 비정상 HTML — 그냥 prepend
        html = BACK_BUTTON_HTML + html;
      }
    }

    await fs.promises.writeFile(htmlPath, html, 'utf-8');
    return true;
  } catch (err) {
    console.warn(`[newman-mobile-inject] ${htmlPath} 처리 실패:`, err.message);
    return false;
  }
}
