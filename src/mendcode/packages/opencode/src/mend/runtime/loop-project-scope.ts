export function loopProjectScopeSql(project: string) {
  return `(p.worktree = ${project} OR EXISTS (
    SELECT 1 FROM workspace AS ws
    WHERE ws.project_id = w.project_id AND ws.directory = ${project}
  ) OR EXISTS (
    SELECT 1 FROM session AS s
    WHERE s.id = w.root_session_id AND s.project_id = w.project_id AND s.directory = ${project}
  ))`
}
