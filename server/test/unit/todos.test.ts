import { describe, expect, it } from "vitest";
import { TaskFolder, todosFromToolCalls, todosFromEventToolCalls, todosFromAnyToolCalls } from "../../src/domain/todos.js";

describe("todosFromToolCalls (TodoWrite family)", () => {
  it("extracts the latest TodoWrite list from mixed tool calls", () => {
    const calls = [
      { callId: "c1", name: "Bash", arguments: "{\"command\":\"ls\"}" },
      { callId: "c2", name: "TodoWrite", arguments: JSON.stringify({ todos: [
        { content: "检查环境", status: "completed" },
        { content: "写代码", status: "in_progress" },
      ] }) },
      { callId: "c3", name: "Read", arguments: "{}" },
    ];
    const todos = todosFromToolCalls(calls);
    expect(todos).toEqual([
      { content: "检查环境", status: "completed" },
      { content: "写代码", status: "in_progress" },
    ]);
  });

  it("the LAST TodoWrite wins (agent updates the list mid-turn)", () => {
    const calls = [
      { callId: "c1", name: "TodoWrite", arguments: JSON.stringify({ todos: [{ content: "旧任务", status: "pending" }] }) },
      { callId: "c2", name: "TodoWrite", arguments: JSON.stringify({ todos: [{ content: "新任务", status: "in_progress" }] }) },
    ];
    expect(todosFromToolCalls(calls)?.[0]?.content).toBe("新任务");
  });

  it("empty todos array means written-and-cleared (not never-written)", () => {
    const todos = todosFromToolCalls([{ callId: "c1", name: "TodoWrite", arguments: "{\"todos\":[]}" }]);
    expect(todos).toEqual([]);
  });

  it("no TodoWrite at all -> undefined (client hides the card, todos:null)", () => {
    expect(todosFromToolCalls([{ callId: "c1", name: "Bash", arguments: "{}" }])).toBeUndefined();
    expect(todosFromToolCalls([])).toBeUndefined();
  });

  it("a torn latest write falls back to the previous valid list, never wipes it", () => {
    const calls = [
      { callId: "c1", name: "TodoWrite", arguments: JSON.stringify({ todos: [{ content: "好任务", status: "completed" }] }) },
      { callId: "c2", name: "TodoWrite", arguments: "{\"todos\": [TRUNCATED" },
    ];
    expect(todosFromToolCalls(calls)?.[0]?.content).toBe("好任务");
  });

  it("invalid statuses or empty contents are rejected", () => {
    expect(todosFromToolCalls([{ name: "TodoWrite", arguments: JSON.stringify({ todos: [{ content: "x", status: "done" }] }) }])).toBeUndefined();
    expect(todosFromToolCalls([{ name: "TodoWrite", arguments: JSON.stringify({ todos: [{ content: "", status: "pending" }] }) }])).toBeUndefined();
  });

  it("assistant/message canonical shape (arguments as JSON string) parses", () => {
    const toolCalls = [
      { callId: "call_e2e", name: "TodoWrite", arguments: JSON.stringify({ todos: [
        { content: "修复 search", status: "completed" },
        { content: "实现 todos", status: "in_progress" },
      ] }) },
    ];
    const viaEvent = todosFromEventToolCalls(toolCalls);
    expect(viaEvent?.map((t) => t.status)).toEqual(["completed", "in_progress"]);
  });
});

describe("TaskFolder (TaskCreate/TaskUpdate family — stateful across events, live shape 2026-09-11)", () => {
  it("folds create/create/update across SEPARATE events (real live sequence)", () => {
    const folder = new TaskFolder();
    // event 1: TaskCreate #1 (own canonical)
    folder.fold([{ callId: "call_a", name: "TaskCreate", arguments: JSON.stringify({ subject: "验证 tasks 投影", description: "验证 tasks 投影", activeForm: "验证 tasks 投影" }) }]);
    // event 2: TaskCreate #2
    folder.fold([{ callId: "call_b", name: "TaskCreate", arguments: JSON.stringify({ subject: "收尾", description: "收尾" }) }]);
    expect(folder.list().map((t) => t.content)).toEqual(["验证 tasks 投影", "收尾"]);
    // event 3: TaskUpdate {taskId:"1", status:"in_progress"} — callId unrelated to the creates
    folder.fold([{ callId: "call_c", name: "TaskUpdate", arguments: JSON.stringify({ taskId: "1", status: "in_progress" }) }]);
    expect(folder.list()).toEqual([
      { content: "验证 tasks 投影", status: "in_progress" },
      { content: "收尾", status: "pending" },
    ]);
  });

  it("subject is used when activeForm is absent", () => {
    const folder = new TaskFolder();
    folder.fold([{ callId: "k1", name: "TaskCreate", arguments: JSON.stringify({ subject: "只有标题" }) }]);
    expect(folder.list()[0]?.content).toBe("只有标题");
  });

  it("completed flips status; deleted removes the row", () => {
    const folder = new TaskFolder();
    folder.fold([{ callId: "k1", name: "TaskCreate", arguments: JSON.stringify({ subject: "A" }) }]);
    folder.fold([{ callId: "k2", name: "TaskCreate", arguments: JSON.stringify({ subject: "B" }) }]);
    folder.fold([{ callId: "k3", name: "TaskUpdate", arguments: JSON.stringify({ taskId: "1", status: "completed" }) }]);
    folder.fold([{ callId: "k4", name: "TaskUpdate", arguments: JSON.stringify({ taskId: "2", status: "deleted" }) }]);
    expect(folder.list()).toEqual([{ content: "A", status: "completed" }]);
  });

  it("multiple Task* calls inside ONE event fold in wire order", () => {
    const folder = new TaskFolder();
    folder.fold([
      { callId: "k1", name: "TaskCreate", arguments: JSON.stringify({ subject: "A" }) },
      { callId: "k2", name: "TaskCreate", arguments: JSON.stringify({ subject: "B" }) },
      { callId: "k3", name: "TaskUpdate", arguments: JSON.stringify({ taskId: "2", status: "in_progress" }) },
    ]);
    expect(folder.list()).toEqual([
      { content: "A", status: "pending" },
      { content: "B", status: "in_progress" },
    ]);
  });

  it("torn JSON and unknown taskIds are skipped, never crash", () => {
    const folder = new TaskFolder();
    folder.fold([{ callId: "k1", name: "TaskCreate", arguments: "{\"subject\": TRUNC" }]);
    folder.fold([{ callId: "k2", name: "TaskUpdate", arguments: JSON.stringify({ taskId: "99", status: "completed" }) }]);
    expect(folder.list()).toEqual([]);
  });
});

describe("todosFromAnyToolCalls (TodoWrite-only extractor; Task* goes through TaskFolder)", () => {
  it("returns the TodoWrite list when present", () => {
    const toolCalls = [
      { callId: "t1", name: "TodoWrite", arguments: JSON.stringify({ todos: [{ content: "清单式", status: "pending" }] }) },
    ];
    expect(todosFromAnyToolCalls(toolCalls)?.[0]?.content).toBe("清单式");
  });

  it("undefined for Task* or unrelated tools (caller folds Task* separately)", () => {
    expect(todosFromAnyToolCalls([{ callId: "k1", name: "TaskCreate", arguments: JSON.stringify({ subject: "单件式" }) }])).toBeUndefined();
    expect(todosFromAnyToolCalls([{ callId: "x", name: "Bash", arguments: "{}" }])).toBeUndefined();
    expect(todosFromAnyToolCalls(undefined)).toBeUndefined();
  });
});
