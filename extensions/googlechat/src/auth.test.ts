import { beforeEach, describe, expect, it, vi } from "vitest";

const getClientMock = vi.fn();
const getAccessTokenMock = vi.fn();

vi.mock("google-auth-library", () => {
  class MockGoogleAuth {
    getClient = getClientMock;
  }
  class MockImpersonated {
    static constructorSpy = vi.fn();
    getAccessToken = getAccessTokenMock;
    constructor(options: unknown) {
      MockImpersonated.constructorSpy(options);
    }
  }
  class MockGaxios {}
  return {
    Gaxios: MockGaxios,
    GoogleAuth: MockGoogleAuth,
    OAuth2Client: vi.fn(),
    Impersonated: MockImpersonated,
  };
});

import { Impersonated } from "google-auth-library";
import { getGoogleChatAccessToken, __testing as googleChatAuthTesting } from "./auth.js";

describe("googlechat auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    googleChatAuthTesting.resetGoogleChatAuthForTests();
  });

  it("returns a token from the standard Google auth client", async () => {
    const client = { getAccessToken: vi.fn().mockResolvedValue({ token: "standard-token" }) };
    getClientMock.mockResolvedValue(client);

    const token = await getGoogleChatAccessToken({ accountId: "default", config: {} } as never);

    expect(token).toBe("standard-token");
    expect(
      (Impersonated as unknown as { constructorSpy: ReturnType<typeof vi.fn> }).constructorSpy,
    ).not.toHaveBeenCalled();
  });

  it("impersonates clientEmail when ADC is used", async () => {
    const sourceClient = { name: "source-client" };
    getClientMock.mockResolvedValue(sourceClient);
    getAccessTokenMock.mockResolvedValue({ token: "impersonated-token" });

    const token = await getGoogleChatAccessToken({
      accountId: "default",
      config: { clientEmail: "target@example.iam.gserviceaccount.com" },
    } as never);

    expect(token).toBe("impersonated-token");
    expect(
      (Impersonated as unknown as { constructorSpy: ReturnType<typeof vi.fn> }).constructorSpy,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceClient,
        targetPrincipal: "target@example.iam.gserviceaccount.com",
        targetScopes: ["https://www.googleapis.com/auth/chat.bot"],
      }),
    );
  });

  it("does not impersonate when direct credentials are configured", async () => {
    const client = { getAccessToken: vi.fn().mockResolvedValue({ token: "key-token" }) };
    getClientMock.mockResolvedValue(client);

    const token = await getGoogleChatAccessToken({
      accountId: "default",
      credentials: {
        type: "service_account",
        client_email: "key@example.iam.gserviceaccount.com",
        private_key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
      },
      config: { clientEmail: "target@example.iam.gserviceaccount.com" },
    } as never);

    expect(token).toBe("key-token");
    expect(
      (Impersonated as unknown as { constructorSpy: ReturnType<typeof vi.fn> }).constructorSpy,
    ).not.toHaveBeenCalled();
  });
});
