// 서식 변환 고정 자료. Node(vitest)와 Deno 테스트가 같은 자료로 같은 결과를 확인한다(C03).
// 값을 바꾸면 ANALYSIS_TEXT_VERSION과 이행 방법을 함께 검토한다.

export interface RichFixture {
  name: string;
  markdown: string;
  analysisText: string;
  visibleLength: number;
}

export const RICH_FIXTURES: RichFixture[] = [
  {
    name: "Joplin 노트(첫 줄 제목 + 줄글)",
    markdown: "2026.10.19\n\n본인가 12월 일자는 미정 실사는 본인가 전에 오픈예정은 1월 일자는 미정\n\n조각투자는 장외시장 기준 거래는 지정가매매",
    analysisText: "2026.10.19\n본인가 12월 일자는 미정 실사는 본인가 전에 오픈예정은 1월 일자는 미정\n조각투자는 장외시장 기준 거래는 지정가매매",
    visibleLength: 76,
  },
  {
    name: "서식·목록·표·링크 혼합",
    markdown: "## 결정\n\n- **수수료** <u>합산</u>\n- <span style=\"color:#1864ab\">절사</span> 처리\n\n| 구분 | 값 |\n| --- | --- |\n| 단건 | 10 |\n\n[문서](https://docs.example/a)",
    analysisText: "결정\n- 수수료 합산\n- 절사 처리\n구분 | 값\n단건 | 10\n문서 (https://docs.example/a)",
    visibleLength: 29,
  },
  {
    name: "줄바꿈(하드 브레이크)과 체크 목록",
    markdown: "첫 줄\\\n둘째 줄  \n셋째 줄\n\n- [ ] 할 일\n- [x] 끝난 일",
    analysisText: "첫 줄\n둘째 줄\n셋째 줄\n- [ ] 할 일\n- [x] 끝난 일",
    visibleLength: 30,
  },
];
