import { describe, expect, it, vi, beforeEach } from "vitest";

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
    constructor() {
      MockPubSub.constructorSpy();
    }
    subscription = pubsubInstanceMock.subscription;
    static constructorSpy = vi.fn();
  }
  return {
    PubSub: MockPubSub,
  };
});

import { PubSub } from "@google-cloud/pubsub";
import { monitorGoogleChatPubSub } from "./monitor-pubsub.js";

const processMessageWithPipelineMock = vi.hoisted(() => vi.fn());
vi.mock("./monitor-shared.js", () => ({
  processMessageWithPipeline: (...args: any[]) => processMessageWithPipelineMock(...args),
  logVerbose: vi.fn(),
  computeGoogleChatMediaMaxMb: () => 20,
}));

vi.mock("./auth.js", () => ({
  getGoogleAuthClient: vi.fn().mockResolvedValue({
    getAccessToken: vi.fn().mockResolvedValue({ token: "test-token" }),
  }),
}));

describe("monitor-pubsub", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    subscriptionMock.on.mockReturnValue(subscriptionMock);
  });

  it("should start pubsub listener and process messages", async () => {
    const abortController = new AbortController();
    await monitorGoogleChatPubSub({
      account: {
        accountId: "test-account",
        config: {
          pubsub: {
            projectId: "test-project",
            subscriptionId: "test-sub",
          },
        },
      } as any,
      config: {} as any,
      runtime: { log: vi.fn(), error: vi.fn() } as any,
      core: {
        logging: { shouldLogVerbose: () => false },
        channel: { reply: { finalizeInboundContext: vi.fn() } },
      } as any,
      mediaMaxMb: 20,
      abortSignal: abortController.signal,
    });

    await vi.waitFor(() => {
      expect((PubSub as any).constructorSpy).toHaveBeenCalled();
      expect(pubsubInstanceMock.subscription).toHaveBeenCalledWith("test-sub");
      expect(subscriptionMock.on).toHaveBeenCalledWith("message", expect.any(Function));
    });

    const messageCall = subscriptionMock.on.mock.calls.find((c) => c[0] === "message");
    const messageHandler = messageCall![1];
    const mockMessage = {
      id: "123",
      data: Buffer.from(
        JSON.stringify({
          type: "MESSAGE",
          space: { name: "spaces/1" },
          message: { text: "hello" },
        }),
      ),
      ack: vi.fn(),
    };

    await messageHandler(mockMessage);

    expect(processMessageWithPipelineMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({ type: "MESSAGE" }),
        mediaMaxMb: 20,
      }),
    );
    expect(mockMessage.ack).toHaveBeenCalled();

    abortController.abort();
    expect(subscriptionMock.close).toHaveBeenCalled();
  });

  it("should handle invalid JSON message data", async () => {
    const abortController = new AbortController();
    const runtimeErrorMock = vi.fn();
    await monitorGoogleChatPubSub({
      account: {
        accountId: "test-account",
        config: {
          pubsub: {
            projectId: "test-project",
            subscriptionId: "test-sub",
          },
        },
      } as any,
      config: {} as any,
      runtime: { log: vi.fn(), error: runtimeErrorMock } as any,
      core: {
        logging: { shouldLogVerbose: () => false },
        channel: { reply: { finalizeInboundContext: vi.fn() } },
      } as any,
      mediaMaxMb: 20,
      abortSignal: abortController.signal,
    });

    await vi.waitFor(() => {
      expect(subscriptionMock.on).toHaveBeenCalledWith("message", expect.any(Function));
    });

    const messageHandler = subscriptionMock.on.mock.calls.find((c) => c[0] === "message")![1];
    const mockMessage = {
      id: "124",
      data: Buffer.from("invalid-json"),
      ack: vi.fn(),
    };

    await messageHandler(mockMessage);

    expect(processMessageWithPipelineMock).not.toHaveBeenCalled();
    expect(mockMessage.ack).toHaveBeenCalled();
    expect(runtimeErrorMock).toHaveBeenCalledWith(
      expect.stringContaining("Error processing Pub/Sub message"),
    );

    abortController.abort();
  });

  it("should ignore non-MESSAGE events", async () => {
    const abortController = new AbortController();
    await monitorGoogleChatPubSub({
      account: {
        accountId: "test-account",
        config: {
          pubsub: {
            projectId: "test-project",
            subscriptionId: "test-sub",
          },
        },
      } as any,
      config: {} as any,
      runtime: { log: vi.fn(), error: vi.fn() } as any,
      core: {
        logging: { shouldLogVerbose: () => false },
        channel: { reply: { finalizeInboundContext: vi.fn() } },
      } as any,
      mediaMaxMb: 20,
      abortSignal: abortController.signal,
    });

    await vi.waitFor(() => {
      expect(subscriptionMock.on).toHaveBeenCalledWith("message", expect.any(Function));
    });

    const messageHandler = subscriptionMock.on.mock.calls.find((c) => c[0] === "message")![1];
    const mockMessage = {
      id: "125",
      data: Buffer.from(JSON.stringify({ type: "ADDED_TO_SPACE" })),
      ack: vi.fn(),
    };

    await messageHandler(mockMessage);

    expect(processMessageWithPipelineMock).not.toHaveBeenCalled();
    expect(mockMessage.ack).toHaveBeenCalled();

    abortController.abort();
  });
});
