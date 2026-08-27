import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const A = "02c7a52b5730927d0dbdb4a263043d9352332ceb04f86078a1f7c61397772a190d";
const B = "03f66a38f61cb7c58049966a647d0d5c7d4cf9f80eac5314e638a775b0819db0dd";

let home: string;
let contacts: typeof import("../src/contacts.js");
const file = () => join(home, ".hypawave", "contacts.json");

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "hw-contacts-test-"));
  vi.stubEnv("HOME", home);
  vi.resetModules();
  contacts = await import("../src/contacts.js");
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe("local contacts store", () => {
  it("saves, reads back and writes the file 0600", () => {
    contacts.saveContact(A, "Oliver", "runs the Q3 pipeline");
    expect(contacts.nameFor(A)).toBe("Oliver");
    expect(readFileSync(file(), "utf8")).toContain("Oliver");
    expect(statSync(file()).mode & 0o777).toBe(0o600);
  });

  it("returns no contacts when the file is missing or corrupt", () => {
    expect(contacts.readContacts()).toEqual({});
    mkdirSync(join(home, ".hypawave"), { recursive: true });
    writeFileSync(file(), "{ not json");
    expect(contacts.readContacts()).toEqual({});
  });

  it("renaming keeps the original saved_at", () => {
    const first = contacts.saveContact(A, "Ollie");
    const renamed = contacts.saveContact(A, "Oliver");
    expect(renamed.saved_at).toBe(first.saved_at);
    expect(contacts.nameFor(A)).toBe("Oliver");
  });

  it("forgets a contact, and reports when there was nothing to forget", () => {
    contacts.saveContact(A, "Oliver");
    expect(contacts.forgetContact(A)).toBe(true);
    expect(contacts.forgetContact(A)).toBe(false);
    expect(contacts.nameFor(A)).toBeUndefined();
  });

  it("labels a pubkey with the operator's name, keeping the pubkey visible", () => {
    expect(contacts.label(A)).toBe("02c7a52b57…");
    contacts.saveContact(A, "Oliver");
    expect(contacts.label(A)).toBe("Oliver (02c7a52b57…)");
  });
});

describe("resolveRecipient", () => {
  it("passes a hex pubkey through, normalising case", () => {
    expect(contacts.resolveRecipient(A)).toBe(A);
    expect(contacts.resolveRecipient(A.toUpperCase())).toBe(A);
  });

  it("resolves a saved name regardless of case or surrounding whitespace", () => {
    contacts.saveContact(A, "Oliver");
    expect(contacts.resolveRecipient("oliver")).toBe(A);
    expect(contacts.resolveRecipient("  OLIVER  ")).toBe(A);
  });

  it("refuses an ambiguous name rather than picking one", () => {
    contacts.saveContact(A, "Bob");
    contacts.saveContact(B, "bob");
    expect(() => contacts.resolveRecipient("Bob")).toThrow(/matches 2 saved contacts/);
  });

  it("lists the saved names when the name is unknown", () => {
    contacts.saveContact(A, "Oliver");
    expect(() => contacts.resolveRecipient("Charlie")).toThrow(/Saved contacts: Oliver/);
  });

  it("explains what to do when nothing is saved yet", () => {
    expect(() => contacts.resolveRecipient("Charlie")).toThrow(/No contacts saved yet/);
  });
});
