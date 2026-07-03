import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HypawaveApiError, hw, isApiError } from "../src/api.js";

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

describe("hw()", () => {
  it("returns parsed JSON on success and passes query params", async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, { offers: [] }));
    const out = await hw("/api/offers/public", { query: { q: "data", limit: 5, skip: undefined } });
    expect(out).toEqual({ offers: [] });
    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.pathname).toBe("/api/offers/public");
    expect(url.searchParams.get("q")).toBe("data");
    expect(url.searchParams.get("limit")).toBe("5");
    expect(url.searchParams.has("skip")).toBe(false);
  });

  it("maps API error envelopes to HypawaveApiError with code + status", async () => {
    mockFetch.mockResolvedValue(jsonResponse(402, { error: "offer_inactive", message: "activation lapsed" }));
    const err = await hw("/api/offers/x/pay", { body: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(HypawaveApiError);
    expect(err.status).toBe(402);
    expect(err.code).toBe("offer_inactive");
    expect(isApiError(err, "offer_inactive")).toBe(true);
    expect(isApiError(err, "terms_changed")).toBe(false);
  });

  it("survives non-JSON error bodies (proxy HTML 502s)", async () => {
    mockFetch.mockResolvedValue(new Response("<html>Bad Gateway</html>", { status: 502 }));
    const err = await hw("/api/get-key").catch((e) => e);
    expect(err).toBeInstanceOf(HypawaveApiError);
    expect(err.code).toBe("http_502");
    expect(err.message).toContain("Bad Gateway");
  });

  it("signs seller requests: headers present and body bytes equal signed bytes", async () => {
    process.env.HYPAWAVE_PRIVKEY = "0000000000000000000000000000000000000000000000000000000000000001";
    mockFetch.mockResolvedValue(jsonResponse(201, { offer_id: "x" }));
    await hw("/api/offers", { body: { amount: 1 }, signed: true });
    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers["x-pubkey"]).toMatch(/^0[23][0-9a-f]{64}$/);
    expect(init.headers["x-signature"]).toMatch(/^[0-9a-f]+$/);
    expect(init.headers["x-nonce"]).toMatch(/^[0-9a-f]{32}$/);
    const sent = JSON.parse(init.body);
    expect(sent.signed_payload_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(sent.signature).toBeDefined();
    delete process.env.HYPAWAVE_PRIVKEY;
  });

  it("uses GET by default and POST when a body is given", async () => {
    mockFetch.mockImplementation(async () => jsonResponse(200, {}));
    await hw("/api/public-settings");
    expect(mockFetch.mock.calls[0][1].method).toBe("GET");
    await hw("/api/offers/x/pay", { body: {} });
    expect(mockFetch.mock.calls[1][1].method).toBe("POST");
  });
});
