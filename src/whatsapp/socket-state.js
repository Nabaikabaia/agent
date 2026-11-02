let socket = null;
let connectionState = "disconnected";

export function setWhatsAppSocket(value) {
  socket = value;
}
export function getWhatsAppSocket() {
  return socket;
}
export function setWhatsAppConnectionState(value) {
  connectionState = String(value || "disconnected");
}
export function getWhatsAppConnectionState() {
  return connectionState;
}

let ownerJid = "";
export function setWhatsAppOwnerJid(value) { ownerJid = String(value || ""); }
export function getWhatsAppOwnerJid() { return ownerJid; }
