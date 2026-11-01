import { ContractFunctionParameters } from "@hiero-ledger/sdk";
import { artifactPath, loadArtifact } from "./artifacts.mjs";

export const GATE_ARTIFACT = artifactPath("CoorReMandateGate.sol", "CoorReMandateGate");
export const REGISTER_SIGNATURE = "registerMandate(bytes32,(uint64,uint64,uint8,bool,bool,bool,bool,bool,uint256),address[],uint8[],uint256[])";
export const REVIEW_SIGNATURE = "recordReview(bytes32,uint256,uint256,bytes32,uint8,bytes32)";
export const DECIDE_SIGNATURE = "decide(bytes32,uint256,uint256,bytes32,uint8,bytes32)";
export const REVIEW_OUTCOME = { resubmit: 1, "close-no-pay": 2 };
export const DEFAULT_MAX_VALIDITY_SECONDS = 90 * 24 * 3600;
export const KIND = { human: 1, agent: 2 };
export const VERDICT = { approve: 1, reject: 2 };
const SCOPE_VERDICTS = ["approve", "reject", "review"];
const GATE_MODES = ["HYBRID"];
const UINT = /^(0|[1-9][0-9]*)$/;

function unixSeconds(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be unix seconds`);
  return value;
}

export function termsFromMandate(document) {
  if (!document || typeof document !== "object" || Array.isArray(document)) throw new Error("a mandate is a JSON object");
  const scope = document.scope;
  if (!scope || typeof scope !== "object") throw new Error("the mandate has no scope");
  const verdicts = scope.verdicts;
  if (!Array.isArray(verdicts) || verdicts.length === 0) throw new Error("the mandate scope names no verdict");
  for (const verdict of verdicts) if (!SCOPE_VERDICTS.includes(verdict)) throw new Error(`unknown verdict ${verdict} in the mandate scope`);
  if (new Set(verdicts).size !== verdicts.length) throw new Error("the mandate scope repeats a verdict");
  if (!Array.isArray(scope.modes) || scope.modes.length !== GATE_MODES.length || !GATE_MODES.every((mode) => scope.modes.includes(mode))) {
    throw new Error(`the gate decides only in ${GATE_MODES.join(", ")} mode`);
  }
  let agreementIds;
  if (scope.agreements === "all") agreementIds = [];
  else if (Array.isArray(scope.agreements) && scope.agreements.length > 0) {
    agreementIds = scope.agreements.map((id) => {
      if (!UINT.test(String(id))) throw new Error(`agreement id ${id} must be a non-negative integer`);
      return String(id);
    });
    if (new Set(agreementIds).size !== agreementIds.length) throw new Error("the mandate scope repeats an agreement");
  } else throw new Error('scope.agreements must be "all" or a non-empty list of agreement ids');
  if (!Array.isArray(document.delegates) || document.delegates.length === 0) throw new Error("a mandate needs at least one delegate");
  const delegates = document.delegates.map((delegate) => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(delegate?.address))) throw new Error("every delegate needs an EVM address");
    if (!Object.hasOwn(KIND, delegate.kind)) throw new Error(`unknown delegate kind ${delegate.kind}`);
    return { address: delegate.address.toLowerCase(), kind: delegate.kind };
  });
  if (!Number.isInteger(document.quorum) || document.quorum < 1 || document.quorum > delegates.length) throw new Error("quorum must be between 1 and the number of delegates");
  const limit = document.autonomyLimit;
  if (limit !== null && !UINT.test(String(limit))) throw new Error("autonomyLimit must be null or a non-negative integer");
  return {
    terms: {
      validFrom: unixSeconds(document.validFrom, "validFrom"),
      validUntil: unixSeconds(document.validUntil, "validUntil"),
      quorum: document.quorum,
      allAgreements: scope.agreements === "all",
      allowApprove: verdicts.includes("approve"),
      allowReject: verdicts.includes("reject"),
      allowReview: verdicts.includes("review"),
      hasAutonomyLimit: limit !== null,
      autonomyLimit: limit === null ? 0 : String(limit),
    },
    delegates,
    agreementIds,
  };
}

export async function loadGate() {
  const gate = await loadArtifact("CoorReMandateGate.sol", "CoorReMandateGate");
  if (!gate.identifiers[REGISTER_SIGNATURE]) throw new Error(`${REGISTER_SIGNATURE} is not in the compiled gate`);
  return gate;
}

export function hexToBytes32(hex) {
  const clean = String(hex).replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) throw new Error("expected 32 bytes of hex");
  return Buffer.from(clean, "hex");
}

export function registerMandateCallData(selectorHex, mandate) {
  const { id, terms, delegates, agreementIds } = mandate;
  if (!/^[0-9a-f]{8}$/.test(selectorHex)) throw new Error("selector must be 8 lowercase hex digits");
  if (delegates.length === 0) throw new Error("a mandate needs at least one delegate");
  for (const delegate of delegates) {
    if (!Object.hasOwn(KIND, delegate.kind)) throw new Error(`unknown delegate kind ${delegate.kind}`);
  }
  const parameters = new ContractFunctionParameters()
    .addBytes32(hexToBytes32(id))
    .addUint64(terms.validFrom)
    .addUint64(terms.validUntil)
    .addUint8(terms.quorum)
    .addBool(terms.allAgreements)
    .addBool(terms.allowApprove)
    .addBool(terms.allowReject)
    .addBool(terms.allowReview)
    .addBool(terms.hasAutonomyLimit)
    .addUint256(terms.autonomyLimit)
    .addAddressArray(delegates.map((delegate) => delegate.address))
    .addUint8Array(delegates.map((delegate) => KIND[delegate.kind]))
    .addUint256Array(agreementIds);
  const args = parameters._build(null);
  const data = new Uint8Array(4 + args.length);
  data.set(Buffer.from(selectorHex, "hex"), 0);
  data.set(args, 4);
  return data;
}
