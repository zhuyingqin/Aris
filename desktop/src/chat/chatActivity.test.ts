import { describe, expect, it } from "vitest";
import { clientRunningConversationCount, setClientChatStreamActivity } from "./chatActivity";

describe("chat close activity", () => {
  it("counts all local streaming surfaces until each has cleared", () => {
    const main = Symbol("main");
    const sideTask = Symbol("side-task");

    setClientChatStreamActivity(main, 2);
    setClientChatStreamActivity(sideTask, 1);
    expect(clientRunningConversationCount()).toBe(3);

    setClientChatStreamActivity(main, 0);
    expect(clientRunningConversationCount()).toBe(1);

    setClientChatStreamActivity(sideTask, 0);
    expect(clientRunningConversationCount()).toBe(0);
  });
});
