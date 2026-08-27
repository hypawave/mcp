import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// A private, local address book: name → pubkey, stored beside identity.json.
//
// Deliberately NOT a server-side namespace. The name never leaves this
// machine, so there is no uniqueness race between agents, no squatting, no
// impersonation surface, and no reserved-word policy — the pubkey stays the
// identity, the name is just this operator's label for it. Same model as the
// contacts app on a phone.
//
// Permissive on save, strict on resolve: two contacts may share a label (an
// operator genuinely knows two Bobs), but a send that could mean either is
// refused rather than guessed. Guessing sends a file to the wrong agent.

const CONTACTS_FILE = join(homedir(), ".hypawave", "contacts.json");
const PUBKEY_RE = /^[0-9a-f]{66}$/;
export const CONTACT_NAME_MAX = 64;

export interface Contact {
  name: string;
  note?: string;
  saved_at: string;
}

/** pubkey → contact. Never throws: an unreadable file means "no contacts yet". */
export function readContacts(): Record<string, Contact> {
  try {
    if (!existsSync(CONTACTS_FILE)) return {};
    const parsed = JSON.parse(readFileSync(CONTACTS_FILE, "utf8"));
    const entries = parsed?.contacts;
    if (!entries || typeof entries !== "object") return {};
    const out: Record<string, Contact> = {};
    for (const [pubkey, v] of Object.entries<any>(entries)) {
      if (PUBKEY_RE.test(pubkey) && typeof v?.name === "string") {
        out[pubkey] = { name: v.name, note: typeof v.note === "string" ? v.note : undefined, saved_at: v.saved_at };
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeContacts(contacts: Record<string, Contact>): void {
  mkdirSync(join(homedir(), ".hypawave"), { recursive: true, mode: 0o700 });
  writeFileSync(CONTACTS_FILE, JSON.stringify({ version: 1, contacts }, null, 2), { mode: 0o600 });
}

export function isPubkey(v: string): boolean {
  return PUBKEY_RE.test(v);
}

export function saveContact(pubkey: string, name: string, note?: string): Contact {
  const contacts = readContacts();
  const entry: Contact = {
    name,
    note,
    // Keep the original save time across a rename.
    saved_at: contacts[pubkey]?.saved_at ?? new Date().toISOString(),
  };
  contacts[pubkey] = entry;
  writeContacts(contacts);
  return entry;
}

export function forgetContact(pubkey: string): boolean {
  const contacts = readContacts();
  if (!contacts[pubkey]) return false;
  delete contacts[pubkey];
  writeContacts(contacts);
  return true;
}

/** The operator's label for a pubkey, or undefined. */
export function nameFor(pubkey: string): string | undefined {
  return readContacts()[pubkey]?.name;
}

/** "Oliver (02c7a52b57…)" when known, else the short pubkey. */
export function label(pubkey: string): string {
  const name = nameFor(pubkey);
  const short = `${pubkey.slice(0, 10)}…`;
  return name ? `${name} (${short})` : short;
}

export class ContactResolutionError extends Error {}

/**
 * Accept either a 66-char hex pubkey or a saved contact name. Matching is
 * case-insensitive and trims whitespace; an ambiguous or unknown name throws
 * with the list of names actually available, so the agent can ask rather than
 * pick.
 */
export function resolveRecipient(input: string): string {
  const value = input.trim();
  if (PUBKEY_RE.test(value.toLowerCase())) return value.toLowerCase();

  const contacts = readContacts();
  const matches = Object.entries(contacts).filter(
    ([, c]) => c.name.trim().toLowerCase() === value.toLowerCase()
  );

  if (matches.length === 1) return matches[0][0];

  const known = Object.values(contacts).map((c) => c.name);
  if (matches.length === 0) {
    throw new ContactResolutionError(
      `No saved contact named "${value}" and it is not a 66-char hex pubkey. ` +
        (known.length
          ? `Saved contacts: ${known.join(", ")}. Ask your operator which they mean, or pass the pubkey.`
          : "No contacts saved yet — pass the pubkey, then save_contact to name it.")
    );
  }
  throw new ContactResolutionError(
    `"${value}" matches ${matches.length} saved contacts (${matches
      .map(([pk]) => `${pk.slice(0, 10)}…`)
      .join(", ")}). Ask your operator which one, and pass the pubkey.`
  );
}
