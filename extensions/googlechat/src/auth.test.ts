import { describe, expect, it, vi, beforeEach } from "vitest";

const getClientMock = vi.fn();
const getAccessTokenMock = vi.fn();

vi.mock("google-auth-library", () => {
  class MockGoogleAuth {
    getClient = getClientMock;
  }
  class MockImpersonated {
    getAccessToken = getAccessTokenMock;
    constructor(options: any) {
      MockImpersonated.constructorSpy(options);
    }
    static constructorSpy = vi.fn();
  }
  return {
    GoogleAuth: MockGoogleAuth,
    OAuth2Client: vi.fn(),
    Impersonated: MockImpersonated,
  };
});

import { Impersonated } from "google-auth-library";
import { getGoogleChatAccessToken } from "./auth.js";

describe("auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return token from standard client when no impersonation is configured", async () => {
    const mockClient = {
      getAccessToken: vi.fn().mockResolvedValue({ token: "standard-token" }),
    };
    getClientMock.mockResolvedValue(mockClient);

    const account = {
      accountId: "default",
      config: {},
    } as any;

    const token = await getGoogleChatAccessToken(account);

    expect(token).toBe("standard-token");
    expect((Impersonated as any).constructorSpy).not.toHaveBeenCalled();
  });

  it("should return token from impersonated client when clientEmail is configured", async () => {
    const sourceClient = { name: "source-client" };
    getClientMock.mockResolvedValue(sourceClient);
    getAccessTokenMock.mockResolvedValue({ token: "impersonated-token" });

    const account = {
      accountId: "default",
      config: {
        clientEmail: "test-sa@example.com",
      },
    } as any;

    const token = await getGoogleChatAccessToken(account);

    expect(token).toBe("impersonated-token");
    expect((Impersonated as any).constructorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        targetPrincipal: "test-sa@example.com",
        sourceClient: sourceClient,
      }),
    );
  });

  it("should not impersonate if direct credentials are provided even if clientEmail is present", async () => {
    const mockClient = {
      getAccessToken: vi.fn().mockResolvedValue({ token: "key-token" }),
    };
    getClientMock.mockResolvedValue(mockClient);

    const account = {
      accountId: "default",
      credentialsFile: "/path/to/key.json",
      config: {
        clientEmail: "test-sa@example.com",
      },
    } as any;

    const token = await getGoogleChatAccessToken(account);

    expect(token).toBe("key-token");
    expect((Impersonated as any).constructorSpy).not.toHaveBeenCalled();
  });
});
