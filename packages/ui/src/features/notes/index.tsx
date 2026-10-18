export const notesFeature = {
  id: "notes",
  title: "요약·결정사항",
} as const;

export function NotesPage() {
  return (
    <section>
      <h2>요약·결정사항</h2>
      <p className="placeholder">분석 결과 편집과 재분석 보호 (Phase 2~3)</p>
    </section>
  );
}
