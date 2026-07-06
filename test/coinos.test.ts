import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCoinosWallet } from "../src/coinos.js";

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
  mockFetch.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const NWC = `nostr+walletconnect://${"a".repeat(64)}?relay=wss%3A%2F%2Frelay.coinos.io&secret=${"b".repeat(64)}`;

describe("createCoinosWallet()", () => {
  it("registers, fetches the auto-created NWC app, and returns credentials", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse(200, { token: "jwt123" }))
      .mockResolvedValueOnce(jsonResponse(200, [{ pubkey: "pk", nwc: NWC }]));

    const w = await createCoinosWallet();

    expect(w.provider).toBe("coinos");
    expect(w.nwc_url).toBe(NWC);
    expect(w.username).toMatch(/^hw[0-9a-f]{12}$/); // Coinos allows letters+numbers only, 2–24 chars
    expect(w.password.length).toBeGreaterThanOrEqual(24);
    expect(w.lightning_address).toBe(`${w.username}@coinos.io`);

    // register call: POST, no auth, {user:{username,password}}
    const [regUrl, regInit] = mockFetch.mock.calls[0];
    expect(String(regUrl)).toBe("https://coinos.io/api/register");
    expect(regInit.method).toBe("POST");
    expect(JSON.parse(regInit.body).user).toEqual({ username: w.username, password: w.password });

    // apps call: GET with Bearer token
    const [appsUrl, appsInit] = mockFetch.mock.calls[1];
    expect(String(appsUrl)).toBe("https://coinos.io/api/apps");
    expect(appsInit.method).toBe("GET");
    expect(appsInit.headers.authorization).toBe("Bearer jwt123");
  });

  it("throws on registration failure with the response body", async () => {
    mockFetch.mockResolvedValueOnce(new Response("Username hw1 taken", { status: 500 }));
    await expect(createCoinosWallet()).rejects.toThrow(/register.*500.*taken/s);
  });

  it("throws when registration returns no token", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, {}));
    await expect(createCoinosWallet()).rejects.toThrow(/no auth token/);
  });

  it("throws when no NWC app is present on the new account", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse(200, { token: "jwt123" }))
      .mockResolvedValueOnce(jsonResponse(200, [{ pubkey: "pk" }]));
    await expect(createCoinosWallet()).rejects.toThrow(/no NWC connection/);
  });

  it("throws on non-JSON success bodies", async () => {
    mockFetch.mockResolvedValueOnce(new Response("<html>cf challenge</html>", { status: 200 }));
    await expect(createCoinosWallet()).rejects.toThrow(/non-JSON/);
  });
});
