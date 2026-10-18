export const tasksFeature = {
  id: "tasks",
  title: "할 일",
} as const;

export function TasksPage() {
  return (
    <section>
      <h2>할 일</h2>
      <p className="placeholder">담당자·기한·상태 관리 (Phase 2)</p>
    </section>
  );
}
