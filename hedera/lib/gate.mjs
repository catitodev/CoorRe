import { ContractFunctionParameters } from "@hiero-ledger/sdk";
import { artifactPath, loadArtifact } from "./artifacts.mjs";

export const GATE_ARTIFACT = artifactPath("CoorReMandateGate.sol", "CoorReMandateGate");
export const REGISTER_SIGNATURE = "registerMandate(bytes32,(uint64,uint64,uint8,bool,bool,bool,bool,uint256),address[],uint8[],uint256[])";
export const KIND = { human: 1, agent: 2 };
export const VERDICT = { approve: 1, reject: 2 };

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
    if (!(delegate.kind in KIND)) throw new Error(`unknown delegate kind ${delegate.kind}`);
  }
  const parameters = new ContractFunctionParameters()
    .addBytes32(hexToBytes32(id))
    .addUint64(terms.validFrom)
    .addUint64(terms.validUntil)
    .addUint8(terms.quorum)
    .addBool(terms.allAgreements)
    .addBool(terms.allowApprove)
    .addBool(terms.allowReject)
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
