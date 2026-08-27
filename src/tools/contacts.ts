import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { jsonResult } from "../util.js";
import { CONTACT_NAME_MAX, forgetContact, isPubkey, readContacts, saveContact } from "../contacts.js";

// The local address book. Names live only on this machine — see contacts.ts.
export function registerContactTools(server: McpServer) {
  server.registerTool(
    "save_contact",
    {
      title: "Name an agent so you never handle hex again",
      description:
        "Save (or rename, or forget) your operator's label for another agent's pubkey — stored locally, never sent " +
        "to Hypawave. After saving, send_wave / send_file / read_wave accept the name in place of the pubkey. " +
        "Take the name from what your operator already told you (\"my friend Bob sent this\") rather than " +
        "interrogating them; ask only when it is genuinely unclear. When an unknown pubkey messages your operator, " +
        "offering to save it is the natural moment.",
      inputSchema: {
        pubkey: z.string().regex(/^[0-9a-f]{66}$/, "66-char hex compressed pubkey").describe("The agent's pubkey"),
        name: z
          .string()
          .min(1)
          .max(CONTACT_NAME_MAX)
          .optional()
          .describe("Your operator's label, e.g. 'Bob'. Required unless action is 'forget'."),
        note: z.string().max(280).optional().describe("Optional reminder, e.g. 'runs the Q3 data pipeline'"),
        action: z.enum(["save", "forget"]).default("save"),
      },
    },
    async ({ pubkey, name, note, action }) => {
      if (action === "forget") {
        return jsonResult({ action, pubkey, removed: forgetContact(pubkey) });
      }
      if (!name || !name.trim()) {
        throw new Error("name is required when saving a contact");
      }
      const trimmed = name.trim();
      // A hex-shaped name would make "is this a name or an address?" ambiguous
      // for every caller that accepts either.
      if (isPubkey(trimmed.toLowerCase())) {
        throw new Error("name must not look like a pubkey");
      }
      const saved = saveContact(pubkey, trimmed, note);
      const duplicates = Object.entries(readContacts()).filter(
        ([pk, c]) => pk !== pubkey && c.name.toLowerCase() === trimmed.toLowerCase()
      );
      return jsonResult({
        action,
        contact: { name: saved.name, pubkey, note: saved.note },
        warning: duplicates.length
          ? `You already have ${duplicates.length} other contact(s) named "${trimmed}". Saving is allowed, but ` +
            "sending by that name will be refused as ambiguous — use the pubkey, or rename one of them."
          : undefined,
      });
    }
  );

  server.registerTool(
    "list_contacts",
    {
      title: "List the agents your operator has named",
      description:
        "Your operator's local address book — names they gave other agents' pubkeys. Use it to resolve who they " +
        "mean (\"send this to Bob\") and to report inbound messages by name instead of hex.",
      inputSchema: {},
    },
    async () => {
      const contacts = readContacts();
      return jsonResult({
        contacts: Object.entries(contacts)
          .map(([pubkey, c]) => ({ name: c.name, pubkey, note: c.note, saved_at: c.saved_at }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        count: Object.keys(contacts).length,
      });
    }
  );
}
