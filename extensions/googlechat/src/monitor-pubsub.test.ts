import { beforeEach, describe, expect, it, vi } from "vitest";

const subscriptionMock = {
  on: vi.fn(),
  removeListener: vi.fn(),
  close: vi.fn().mockResolvedValue(undefined),
  exists: vi.fn().mockResolvedValue([true]),
};

const pubsubInstanceMock = {
  subscription: vi.fn().mockReturnValue(subscriptionMock),
};

vi.mock("@google-cloud/pubsub", () => {
  class MockPubSub {
    static constructorSpy = vi.fn();
    subscription = pubsubInstanceMock.subscription;
    constructor(options: unknown) {
      MockPubSub.constructorSpy(options);
    }
  }
  return { PubSub: MockPubSub };
});

import { PubSub } from "@google-cloud/pubsub";
import { monitorGoogleChatPubSub } from "./monitor-pubsub.js";

describe("monitor-pubsub", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    subscriptionMock.exists.mockResolvedValue([true]);
    subscriptionMock.close.mockResolvedValue(undefined);
    subscriptionMock.on.mockReturnValue(subscriptionMock);
  });

  it("starts a Pub/Sub listener and processes message events", async () => {
    const abortController = new AbortController();
    const processEvent = vi.fn().mockResolvedValue(undefined);
    const monitorPromise = monitorGoogleChatPubSub({
      account: {
        accountId: "test-account",
        config: { pubsub: { projectId: "test-project", subscriptionId: "test-sub" } },
      } as never,
      runtime: { log: vi.fn(), error: vi.fn() },
      core: { logging: { shouldLogVerbose: () => false } } as never,
      abortSignal: abortController.signal,
      processEvent,
    });

    await vi.waitFor(() => {
      expect(
        (PubSub as unknown as { constructorSpy: unknown }).constructorSpy,
      ).toHaveBeenCalledWith({ projectId: "test-project" });
      expect(pubsubInstanceMock.subscription).toHaveBeenCalledWith("test-sub");
      expect(subscriptionMock.on).toHaveBeenCalledWith("message", expect.any(Function));
    });

    const messageHandler = subscriptionMock.on.mock.calls.find(
      (call) => call[0] === "message",
    )?.[1];
    expect(messageHandler).toBeTypeOf("function");
    const message = {
      id: "123",
      data: Buffer.from(
        JSON.stringify({ type: "MESSAGE", space: { name: "spaces/1" }, message: { text: "hi" } }),
      ),
      ack: vi.fn(),
    };
    await messageHandler(message);

    expect(processEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "MESSAGE" }));
    expect(message.ack).toHaveBeenCalled();

    abortController.abort();
    await monitorPromise;
    expect(subscriptionMock.close).toHaveBeenCalled();
  });

  it("acks invalid JSON and logs an error", async () => {
    const abortController = new AbortController();
    const runtimeError = vi.fn();
    const processEvent = vi.fn();
    const monitorPromise = monitorGoogleChatPubSub({
      account: {
        accountId: "test-account",
        config: { pubsub: { subscriptionId: "test-sub" } },
      } as never,
      runtime: { log: vi.fn(), error: runtimeError },
      core: { logging: { shouldLogVerbose: () => false } } as never,
      abortSignal: abortController.signal,
      processEvent,
    });

    await vi.waitFor(() => {
      expect(subscriptionMock.on).toHaveBeenCalledWith("message", expect.any(Function));
    });

    const messageHandler = subscriptionMock.on.mock.calls.find(
      (call) => call[0] === "message",
    )?.[1];
    const message = { id: "124", data: Buffer.from("not-json"), ack: vi.fn() };
    await messageHandler(message);

    expect(processEvent).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalled();
    expect(runtimeError).toHaveBeenCalledWith(
      expect.stringContaining("Error processing Pub/Sub message"),
    );

    abortController.abort();
    await monitorPromise;
  });

  it("acks and ignores non-message events", async () => {
    const abortController = new AbortController();
    const processEvent = vi.fn();
    const monitorPromise = monitorGoogleChatPubSub({
      account: {
        accountId: "test-account",
        config: { pubsub: { subscriptionId: "test-sub" } },
      } as never,
      runtime: { log: vi.fn(), error: vi.fn() },
      core: { logging: { shouldLogVerbose: () => false } } as never,
      abortSignal: abortController.signal,
      processEvent,
    });

    await vi.waitFor(() => {
      expect(subscriptionMock.on).toHaveBeenCalledWith("message", expect.any(Function));
    });

    const messageHandler = subscriptionMock.on.mock.calls.find(
      (call) => call[0] === "message",
    )?.[1];
    const message = {
      id: "125",
      data: Buffer.from(JSON.stringify({ type: "ADDED_TO_SPACE" })),
      ack: vi.fn(),
    };
    await messageHandler(message);

    expect(processEvent).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalled();

    abortController.abort();
    await monitorPromise;
  });
});
