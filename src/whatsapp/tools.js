import { getWhatsAppSocket, getWhatsAppOwnerJid } from "./socket-state.js";
import { requestUserChoice } from "../interaction.js";
import { discoverWhatsAppApi, listWhatsAppCapabilities, registerWhatsAppCapability, executeRegisteredWhatsAppCapability } from "./capability-registry.js";

export const whatsappToolDefinitions = [
  { type: "function", function: { name: "whatsapp_discover_api", description: "Inspect the connected Baileys version and discover available public socket methods. Use this when a requested WhatsApp feature is not in the current tool list.", parameters: { type: "object", properties: {}, additionalProperties: false } } },
  { type: "function", function: { name: "whatsapp_list_capabilities", description: "List additional owner-approved WhatsApp capabilities registered from the installed Baileys API.", parameters: { type: "object", properties: {}, additionalProperties: false } } },
  { type: "function", function: { name: "whatsapp_register_capability", description: "Register a reusable wrapper for an available public Baileys socket method after researching its exact signature. Registration requires owner approval. Provide argument guidance so the capability can be reused accurately.", parameters: { type: "object", properties: { name: { type: "string" }, method: { type: "string" }, description: { type: "string" }, arguments_description: { type: "string" }, risk: { type: "string", enum: ["read", "write", "destructive"] } }, required: ["name", "method", "description", "arguments_description", "risk"], additionalProperties: false } } },
  { type: "function", function: { name: "whatsapp_call_capability", description: "Execute an owner-approved registered Baileys capability. Supply arguments in the exact order and shape documented for that method. Mutating methods always require owner confirmation.", parameters: { type: "object", properties: { name: { type: "string" }, args: { type: "array", items: {} } }, required: ["name", "args"], additionalProperties: false } } },
  { type: "function", function: { name: "whatsapp_send_message", description: "Send a WhatsApp text message to a phone number or JID. Sending to anyone other than the configured owner requires explicit owner confirmation.", parameters: { type: "object", properties: { to: { type: "string" }, text: { type: "string", minLength: 1, maxLength: 4000 } }, required: ["to", "text"], additionalProperties: false } } },
  { type: "function", function: { name: "whatsapp_list_groups", description: "List WhatsApp groups available to the linked account.", parameters: { type: "object", properties: {}, additionalProperties: false } } },
  { type: "function", function: { name: "whatsapp_group_metadata", description: "Get metadata and participants for a WhatsApp group by group JID.", parameters: { type: "object", properties: { group_jid: { type: "string" } }, required: ["group_jid"], additionalProperties: false } } },
  { type: "function", function: { name: "whatsapp_group_setting", description: "Change a WhatsApp group's messaging or settings permissions. Values: announcement (admins only can message), not_announcement (all members can message), locked (only admins can edit group settings), unlocked (all members can edit settings). Confirm the exact group and requested setting before executing.", parameters: { type: "object", properties: { group_jid: { type: "string" }, setting: { type: "string", enum: ["announcement", "not_announcement", "locked", "unlocked"] } }, required: ["group_jid", "setting"], additionalProperties: false } } },
  { type: "function", function: { name: "whatsapp_block_contact", description: "Block or unblock a WhatsApp contact by phone number. Requires explicit owner confirmation before changing the block list.", parameters: { type: "object", properties: { number: { type: "string" }, action: { type: "string", enum: ["block", "unblock"] } }, required: ["number", "action"], additionalProperties: false } } },
  { type: "function", function: { name: "whatsapp_group_participant", description: "Add, remove, promote, or demote a participant in a WhatsApp group. Requires explicit owner confirmation and sufficient group admin permissions.", parameters: { type: "object", properties: { group_jid: { type: "string" }, number: { type: "string" }, action: { type: "string", enum: ["add", "remove", "promote", "demote"] } }, required: ["group_jid", "number", "action"], additionalProperties: false } } },
  { type: "function", function: { name: "whatsapp_group_invite_link", description: "Fetch a WhatsApp group invite code/link for a group where the linked account has permission.", parameters: { type: "object", properties: { group_jid: { type: "string" }, reset: { type: "boolean" } }, required: ["group_jid"], additionalProperties: false } } },
  { type: "function", function: { name: "whatsapp_block_list", description: "Retrieve the linked WhatsApp account's blocked contact list.", parameters: { type: "object", properties: {}, additionalProperties: false } } }
];

function jid(value) {
  const input = String(value || "").trim();
  if (input.endsWith("@g.us") || input.endsWith("@s.whatsapp.net")) return input;
  const digits = input.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) throw new Error("Provide a valid international phone number or WhatsApp JID.");
  return digits + "@s.whatsapp.net";
}

async function confirmSensitive(action) {
  const result = await requestUserChoice({
    prompt: "Nabees requests your approval to perform this WhatsApp action:\n\n" + action + "\n\nThis changes WhatsApp account or group state. Proceed?",
    choices: ["Approve action", "Cancel"],
    timeout_seconds: 300
  });
  if (result.timed_out || result.selected !== "Approve action") throw new Error("WhatsApp action was not approved (" + (result.timed_out ? "approval expired" : "cancelled") + ").");
}

async function requireSocket() {
  const sock = getWhatsAppSocket();
  if (!sock) throw new Error("WhatsApp is not connected. Pair the account first.");
  return sock;
}

export async function executeWhatsAppTool(name, args = {}) {
  const sock = await requireSocket();
  switch (name) {
    case "whatsapp_discover_api": return await discoverWhatsAppApi();
    case "whatsapp_list_capabilities": return await listWhatsAppCapabilities();
    case "whatsapp_register_capability": return await registerWhatsAppCapability(args);
    case "whatsapp_call_capability": return await executeRegisteredWhatsAppCapability(args);
    case "whatsapp_send_message": {
      const to = jid(args.to);
      if (to !== getWhatsAppOwnerJid()) await confirmSensitive("Send a WhatsApp message to " + to + ": " + String(args.text || "").slice(0, 300));
      const result = await sock.sendMessage(to, { text: String(args.text || "").slice(0, 4000) });
      return { sent: true, to, message_id: result?.key?.id || null };
    }
    case "whatsapp_list_groups": {
      const groups = await sock.groupFetchAllParticipating();
      return Object.values(groups || {}).map(group => ({
        id: group.id, subject: group.subject, owner: group.owner || null,
        size: group.size || group.participants?.length || 0,
        announce: Boolean(group.announce), restrict: Boolean(group.restrict)
      }));
    }
    case "whatsapp_group_metadata": {
      const group = await sock.groupMetadata(jid(args.group_jid));
      return { id: group.id, subject: group.subject, owner: group.owner || null, desc: group.desc || "", participants: (group.participants || []).map(p => ({ id: p.id, admin: p.admin || null })) };
    }
    case "whatsapp_group_setting": {
      const groupJid = jid(args.group_jid);
      const allowed = new Set(["announcement", "not_announcement", "locked", "unlocked"]);
      if (!allowed.has(args.setting)) throw new Error("Unsupported group setting.");
      await confirmSensitive("Change group " + groupJid + " to setting " + args.setting + ".");
      await sock.groupSettingUpdate(groupJid, args.setting);
      return { updated: true, group_jid: groupJid, setting: args.setting };
    }
    case "whatsapp_block_contact": {
      const number = jid(args.number);
      await confirmSensitive((args.action === "block" ? "Block " : "Unblock ") + number + ".");
      await sock.updateBlockStatus(number, args.action === "block" ? "block" : "unblock");
      return { updated: true, number, action: args.action };
    }
    case "whatsapp_group_participant": {
      const groupJid = jid(args.group_jid);
      const number = jid(args.number);
      if (!["add", "remove", "promote", "demote"].includes(args.action)) throw new Error("Unsupported participant action.");
      await confirmSensitive("Perform group participant action " + args.action + " for " + number + " in " + groupJid + ".");
      const result = await sock.groupParticipantsUpdate(groupJid, [number], args.action);
      return { updated: true, group_jid: groupJid, number, action: args.action, result };
    }
    case "whatsapp_group_invite_link": {
      const groupJid = jid(args.group_jid);
      if (args.reset) await confirmSensitive("Reset the invite link for group " + groupJid + ". Existing invite links will stop working.");
      const code = args.reset ? await sock.groupRevokeInvite(groupJid) : await sock.groupInviteCode(groupJid);
      return { group_jid: groupJid, invite_link: "https://chat.whatsapp.com/" + code, reset: Boolean(args.reset) };
    }
    case "whatsapp_block_list": {
      return await sock.fetchBlocklist();
    }
    default: throw new Error("Unknown WhatsApp tool: " + name);
  }
}
