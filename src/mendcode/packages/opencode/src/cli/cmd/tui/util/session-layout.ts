export function sessionPromptVisible(input: {
  isChildSession: boolean
  permissionCount: number
  questionCount: number
  planReviewCount: number
}) {
  void input.isChildSession
  return input.permissionCount === 0 && input.questionCount === 0 && input.planReviewCount === 0
}
