import { createHash } from "node:crypto";

export function jcs(value) {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("JCS cannot encode a non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(jcs).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    const members = [];
    for (const key of keys) {
      if (value[key] === undefined) throw new Error(`JCS cannot encode undefined at ${key}`);
      members.push(`${JSON.stringify(key)}:${jcs(value[key])}`);
    }
    return `{${members.join(",")}}`;
  }
  throw new Error(`JCS cannot encode a ${typeof value}`);
}

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function jcsHash(value) {
  return sha256Hex(Buffer.from(jcs(value), "utf8"));
}

export function caseRef(hostId, chainId, escrow, agreementId, periodId) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(hostId)) throw new Error("hostId must be lowercase letters, digits and dashes");
  if (!Number.isInteger(chainId) || chainId <= 0) throw new Error("chainId must be a positive integer");
  if (!/^0x[0-9a-fA-F]{40}$/.test(escrow)) throw new Error("escrow must be an EVM address");
  for (const [name, id] of [["agreementId", agreementId], ["periodId", periodId]]) {
    if (!/^(0|[1-9][0-9]*)$/.test(String(id))) throw new Error(`${name} must be a non-negative integer`);
  }
  return `urn:coorre:case:${hostId}:${chainId}:${escrow.toLowerCase()}:${agreementId}:${periodId}`;
}

export function caseId(ref) {
  return sha256Hex(Buffer.from(ref, "utf8"));
}

export function mandateId(mandate) {
  if (!mandate || typeof mandate !== "object" || Array.isArray(mandate)) throw new Error("a mandate is a JSON object");
  if ("mandateId" in mandate) throw new Error("the mandate document must not contain its own id");
  return jcsHash(mandate);
}
