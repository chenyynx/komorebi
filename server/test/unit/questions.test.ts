import { describe, expect, it } from "vitest";
import { parseClientQuestions, buildAnswerRecord } from "../../src/domain/questions.js";

const REAL_TRANSCRIPT_INPUT = {
  questions: [
    {
      question: "两个根因都修吗？",
      header: "修复范围",
      multiSelect: false,
      options: [
        { label: "两个都修（推荐）", description: "修复 1：指纹去重 + 修复 2：孤立 tool_result。3 文件 +~40 行。" },
        { label: "只修 1（重复）", description: "只加内容指纹去重。1 文件 ~15 行。" },
      ],
    },
  ],
};

describe("parseClientQuestions (input shape verified against a real transcript 2026-09-11)", () => {
  it("maps questions to client GatewayQuestion items with positional ids", () => {
    const qs = parseClientQuestions(REAL_TRANSCRIPT_INPUT);
    expect(qs).toBeDefined();
    expect(qs?.[0]).toEqual({
      id: "q0",
      question: "两个根因都修吗？",
      header: "修复范围",
      multiSelect: false,
      options: [
        { label: "两个都修（推荐）", description: "修复 1：指纹去重 + 修复 2：孤立 tool_result。3 文件 +~40 行。" },
        { label: "只修 1（重复）", description: "只加内容指纹去重。1 文件 ~15 行。" },
      ],
    });
  });

  it("assigns stable ids q0..qN across multiple questions (client answers by id)", () => {
    const qs = parseClientQuestions({
      questions: [
        { question: "A?" },
        { question: "B?", options: [{ label: "x" }] },
      ],
    });
    expect(qs?.map((q) => q.id)).toEqual(["q0", "q1"]);
    expect(qs?.[0].options).toBeUndefined();
  });

  it("rejects unusable inputs (caller must deny instead of hanging the turn)", () => {
    expect(parseClientQuestions({})).toBeUndefined();
    expect(parseClientQuestions({ questions: [] })).toBeUndefined();
    expect(parseClientQuestions({ questions: "nope" })).toBeUndefined();
    expect(parseClientQuestions({ questions: [{ header: "没有正文" }] })).toBeUndefined();
    expect(parseClientQuestions({ questions: [{ question: "   " }] })).toBeUndefined();
  });
});

describe("buildAnswerRecord (bridge buildAskUserAnswers precedent)", () => {
  const qs = [
    { id: "q0", question: "两个根因都修吗？" },
    { id: "q1", question: "选库？" },
  ];

  it("custom text wins over selected labels; selected join by comma-space", () => {
    const rec = buildAnswerRecord(qs, [
      { id: "q0", selected: ["两个都修（推荐）"], custom: "都修，并且今天上线" },
      { id: "q1", selected: ["A", "B"] },
    ]);
    expect(rec).toEqual({ "两个根因都修吗？": "都修，并且今天上线", "选库？": "A, B" });
  });

  it("empty/blank custom falls through to selected; unknown ids skipped", () => {
    const rec = buildAnswerRecord(qs, [
      { id: "q0", custom: "  ", selected: ["只修 1（重复）"] },
      { id: "q9", selected: ["垃圾"] },
    ]);
    expect(rec).toEqual({ "两个根因都修吗？": "只修 1（重复）" });
  });

  it("a question with no answer at all is omitted (SDK tolerates partial envelopes)", () => {
    expect(buildAnswerRecord(qs, [{ id: "q1", selected: [] }])).toEqual({});
  });
});
