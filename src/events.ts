/**
 * The subset of OpenCode's event stream this bridge reacts to.
 *
 * The real event stream is a large discriminated union; only the fields the
 * bridge reads are described here so the plugin has no type dependency on
 * `@opencode/client`. Values are cast at the subscription boundary.
 */

export interface EventLocation {
  directory: string
  workspaceID?: string
}

export interface BridgeEvent {
  id: string
  type: string
  created: number
  location?: EventLocation
  data: Record<string, any>
}

export interface QuestionOption {
  label: string
  description?: string
}

export interface QuestionPrompt {
  question: string
  header?: string
  options?: QuestionOption[]
  multiple?: boolean
}

export interface PermissionRequestData {
  id: string
  sessionID: string
  action: string
  resources: string[]
  save?: string[]
  message?: string
  metadata?: Record<string, unknown>
}

export interface SessionCreatedData {
  sessionID: string
  parentID?: string
  title?: string
}

export function isQuestionPrompt(value: unknown): value is QuestionPrompt {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.question === "string" && candidate.question.trim() !== ""
}

/** Coerce whatever the model sent into the shape the bridge renders. */
export function normalizeQuestions(input: unknown): QuestionPrompt[] {
  const questions = (input as { questions?: unknown } | undefined)?.questions
  if (!Array.isArray(questions)) throw new Error("Invalid question input: expected a `questions` array.")
  const normalized = questions
    .filter(isQuestionPrompt)
    .map((question) => ({
      question: question.question.trim(),
      header: typeof question.header === "string" && question.header.trim() !== "" ? question.header.trim() : undefined,
      multiple: question.multiple === true,
      options: Array.isArray(question.options)
        ? question.options
            .filter((option) => typeof option?.label === "string" && option.label.trim() !== "")
            .map((option) => ({
              label: option.label.trim(),
              description:
                typeof option.description === "string" && option.description.trim() !== ""
                  ? option.description.trim()
                  : undefined,
            }))
        : [],
    }))
  if (normalized.length === 0) throw new Error("Invalid question input: no usable questions were provided.")
  return normalized
}

/** Same wording the built-in question tool returns, so the model sees familiar feedback. */
export function toModelContent(questions: ReadonlyArray<QuestionPrompt>, answers: ReadonlyArray<ReadonlyArray<string>>): string {
  const formatted = questions
    .map((question, index) => `"${question.question}"="${answers[index]?.length ? answers[index].join(", ") : "Unanswered"}"`)
    .join(", ")
  return `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`
}

export function describeFailure(value: unknown): string {
  if (typeof value === "string") return value
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>
    const message = record.message ?? record.error ?? record.code
    if (typeof message === "string" && message.trim() !== "") return message
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return String(value)
}
