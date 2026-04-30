import { describe, expect, it, vi, beforeEach } from "vitest";

const getAccessTokenMock = vi.fn();
const getClientMock = vi.fn();

vi.mock("google-auth-library", () => {
  class MockGoogleAuth {
    getClient = getClientMock;
  }
  return {
    GoogleAuth: MockGoogleAuth,
  };
});

// Mock the plugin SDK to prevent resolution errors during testing
vi.mock("openclaw/plugin-sdk/logging-core", () => ({
  logVerbose: vi.fn(),
}));

import { resolveGoogleAdcToken, __testing as adcAuthTesting } from "./adc-auth.js";

describe("adc-auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adcAuthTesting.resetCache();
    getAccessTokenMock.mockReset();
    getClientMock.mockReset();
  });

  it("should return token from GoogleAuth when available as object", async () => {
    getClientMock.mockResolvedValue({
      getAccessToken: getAccessTokenMock.mockResolvedValue({ token: "test-adc-token-obj" }),
    });

    const token = await resolveGoogleAdcToken();

    expect(token).toBe("test-adc-token-obj");
    expect(getClientMock).toHaveBeenCalled();
  });

  it("should return token from GoogleAuth when available as string", async () => {
    getClientMock.mockResolvedValue({
      getAccessToken: getAccessTokenMock.mockResolvedValue("test-adc-token-str"),
    });

    const token = await resolveGoogleAdcToken();

    expect(token).toBe("test-adc-token-str");
  });

  it("should return null when token resolution fails", async () => {
    getClientMock.mockRejectedValue(new Error("auth failed"));

    const token = await resolveGoogleAdcToken();

    expect(token).toBeNull();
  });
});
