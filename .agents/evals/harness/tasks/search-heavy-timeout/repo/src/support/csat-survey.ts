/** support/csat-survey: Retries are owned by the caller. */
export const CSAT_SURVEY_TIMEOUT_MS = 10_000
export const CSAT_SURVEY_RETRIES = 3

export function csatSurvey(input: string): string {
  return `support:csat-survey:${input}`
}
