/**
 * AskUserQuestion → the phone's question channel.
 *
 * CC's AskUserQuestion tool input (verified against this host's real
 * transcript 2026-09-11 + SDK sdk-tools.d.ts AskUserQuestionInput):
 *   { questions: [{ question, header?, options?: [{label, description?}],
 *                  multiSelect?, preview?, notes? }], answers? }
 * Client contract (GatewayDtos.kt): GatewayQuestion {id, header?, question,
 * detail?, options?[{label, description?}], multiSelect?, intent?} and answers
 * back as {id, selected: [labels], custom?}.
 *
 * Feeding answers back to the SDK: the production-proven bridge mechanism
 * (claudio sdk-process.ts answer()): resolve canUseTool with
 *   { behavior: "allow", updatedInput: { ...input, answers: Record<questionText, answerText> } }
 * — the answers ride the tool input; CC's AskUserQuestion renders them as its
 * tool result. This module mirrors that mapping.
 * @module domain/questions
 */

import type { ClientQuestion } from "../protocol/frames.js";

/** Parse+validate AskUserQuestion tool input into client questions.
 * undefined = unusable (caller must deny rather than silently hang). */
export function parseClientQuestions(input: Record<string, unknown>): readonly ClientQuestion[] | undefined {
  const raw = input["questions"];
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const questions: ClientQuestion[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (typeof item !== "object" || item === null || Array.isArray(item)) return undefined;
    const q = item as Record<string, unknown>;
    if (typeof q["question"] !== "string" || q["question"].trim() === "") return undefined;
    const question: ClientQuestion = {
      id: `q${i}`,
      question: q["question"],
      ...(typeof q["header"] === "string" && q["header"] !== "" ? { header: q["header"] } : {}),
      ...(typeof q["multiSelect"] === "boolean" ? { multiSelect: q["multiSelect"] } : {}),
      ...(() => {
        if (!Array.isArray(q["options"])) return {};
        const options = q["options"]
          .filter((o): o is Record<string, unknown> => typeof o === "object" && o !== null)
          .filter((o) => typeof o["label"] === "string" && o["label"] !== "")
          .map((o) => ({
            label: o["label"] as string,
            ...(typeof o["description"] === "string" && o["description"] !== "" ? { description: o["description"] as string } : {}),
          }));
        return options.length > 0 ? { options } : {};
      })(),
    };
    questions.push(question);
  }
  return questions;
}

/** Inbound client answer shape (validation.ts QuestionAnswerFrame.answers). */
export interface ClientAnswer {
  readonly id: string;
  readonly selected?: readonly string[];
  readonly custom?: string;
}

/**
 * Fold client answers back into the SDK's Record<questionText, answerText>
 * (bridge buildAskUserAnswers precedent): custom text wins, otherwise the
 * selected labels joined by ", ". Unknown ids / empty answers are skipped —
 * the SDK tolerates a partially answered envelope, and dropping garbage is
 * safer than inventing an answer the user never chose.
 */
export function buildAnswerRecord(
  questions: readonly ClientQuestion[],
  answers: readonly ClientAnswer[],
): Record<string, string> {
  const byId = new Map(questions.map((q) => [q.id, q.question]));
  const record: Record<string, string> = {};
  for (const answer of answers) {
    const questionText = byId.get(answer.id);
    if (questionText === undefined) continue;
    const custom = typeof answer.custom === "string" ? answer.custom.trim() : "";
    if (custom !== "") {
      record[questionText] = custom;
      continue;
    }
    const selected = (answer.selected ?? []).filter((s) => typeof s === "string" && s.trim() !== "");
    if (selected.length > 0) record[questionText] = selected.join(", ");
  }
  return record;
}
