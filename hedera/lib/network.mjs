import { readFile } from "node:fs/promises";
import {
  AccountId,
  Client,
  ContractCallQuery,
  ContractCreateTransaction,
  ContractExecuteTransaction,
  ContractFunctionParameters,
  FileAppendTransaction,
  FileCreateTransaction,
  FileDeleteTransaction,
  Hbar,
  PrivateKey,
  Status,
  TransactionRecordQuery,
} from "@hiero-ledger/sdk";

const TINYBAR_PER_HBAR = 100_000_000n;
const WEIBAR_PER_HBAR = 10n ** 18n;

export function mirrorTransactionId(transactionId) {
  const match = /^(\d+\.\d+\.\d+)@(\d+)\.(\d+)$/.exec(String(transactionId));
  if (!match) throw new Error(`unexpected transaction id ${transactionId}`);
  return `${match[1]}-${match[2]}-${match[3].padStart(9, "0")}`;
}

export function timestampSeconds(consensusTimestamp) {
  const match = /^(\d+)\.(\d+)$/.exec(String(consensusTimestamp));
  if (!match) throw new Error(`unexpected consensus timestamp ${consensusTimestamp}`);
  return BigInt(match[1]);
}

export function msgValueUnit(observed, hbar) {
  const value = BigInt(observed);
  if (value === BigInt(hbar) * TINYBAR_PER_HBAR) return "tinybar";
  if (value === BigInt(hbar) * WEIBAR_PER_HBAR) return "weibar";
  return "unknown";
}

export function revertSelector(errorMessage) {
  if (typeof errorMessage !== "string") return null;
  const hex = errorMessage.startsWith("0x") ? errorMessage.slice(2) : errorMessage;
  return /^[0-9a-fA-F]{8}/.test(hex) ? `0x${hex.slice(0, 8).toLowerCase()}` : null;
}

export function evmHex(address) {
  return `0x${String(address).replace(/^0x/, "").toLowerCase()}`;
}

export function settings(reportDefault) {
  const accounts = process.env.SOLO_ACCOUNTS;
  if (!accounts) throw new Error("SOLO_ACCOUNTS must point to the accounts.json written by solo one-shot");
  return {
    accounts,
    consensus: process.env.SOLO_CONSENSUS ?? "127.0.0.1:35211",
    nodeAccount: process.env.SOLO_NODE_ACCOUNT ?? "0.0.3",
    mirrorRest: (process.env.SOLO_MIRROR_REST ?? "http://localhost:38081").replace(/\/$/, ""),
    relay: process.env.SOLO_RELAY ?? "http://localhost:37546",
    report: process.env.PROBE_REPORT ?? reportDefault,
  };
}

export function clientFor(config, accountId, privateKey) {
  const client = Client.fromConfig({
    network: { [config.consensus]: AccountId.fromString(config.nodeAccount) },
    scheduleNetworkUpdate: false,
  });
  client.setOperator(accountId, privateKey);
  return client;
}

export async function loadAccounts(path) {
  const data = JSON.parse(await readFile(path, "utf8"));
  const system = data.systemAccounts?.[0];
  if (!system) throw new Error("accounts.json has no systemAccounts[0]");
  const created = (data.createdAccounts ?? []).filter((entry) => typeof entry.privateKey === "string");
  if (created.length < 3) throw new Error("accounts.json needs at least three createdAccounts");
  return {
    operator: { id: AccountId.fromString(system.accountId), key: PrivateKey.fromStringDer(system.privateKey) },
    ecdsa: created.slice(0, 3).map((entry) => ({
      id: AccountId.fromString(entry.accountId),
      key: PrivateKey.fromStringECDSA(entry.privateKey.replace(/^0x/, "")),
    })),
  };
}

export async function submit(client, transaction, extraSigners = []) {
  const frozen = await transaction.freezeWith(client);
  for (const key of extraSigners) await frozen.sign(key);
  let response;
  try {
    response = await frozen.execute(client);
  } catch (error) {
    if (error.status) return { status: error.status.toString(), precheck: true, transactionId: String(error.transactionId ?? "") };
    throw error;
  }
  try {
    const receipt = await response.getReceipt(client);
    return { status: receipt.status.toString(), receipt, transactionId: response.transactionId.toString(), response };
  } catch (error) {
    if (error.status) return { status: error.status.toString(), transactionId: response.transactionId.toString(), response };
    throw error;
  }
}

export async function recordOf(client, transactionId) {
  return new TransactionRecordQuery().setTransactionId(transactionId).setValidateReceiptStatus(false).execute(client);
}

export async function mirror(config, path, accept = (body) => body) {
  const deadline = Date.now() + 90_000;
  let last = null;
  while (Date.now() < deadline) {
    const response = await fetch(`${config.mirrorRest}${path}`);
    if (response.ok) {
      const body = await response.json();
      if (accept(body)) return body;
      last = `unaccepted body for ${path}`;
    } else {
      last = `HTTP ${response.status} for ${path}`;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`mirror node: ${last}`);
}

export async function rpc(config, method, params = []) {
  const response = await fetch(config.relay, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

export function hexBytecode(value) {
  if (typeof value !== "string") throw new Error("bytecode must be a hex string, not raw bytes");
  if (!/^([0-9a-f]{2})+$/.test(value)) throw new Error("bytecode must be lowercase hex without 0x and with whole bytes");
  return value;
}

export const DEFAULT_UPLOAD_CHUNK_CHARS = 1000;

export function selfAdminKeyNumber(adminKeyHex) {
  if (typeof adminKeyHex !== "string" || !/^([0-9a-f]{2})+$/.test(adminKeyHex)) return null;
  const bytes = Buffer.from(adminKeyHex, "hex");
  if (bytes.length < 4 || bytes[0] !== 0x0a || bytes[1] !== bytes.length - 2 || bytes[2] !== 0x18) return null;
  let number = 0n;
  let shift = 0n;
  for (let index = 3; index < bytes.length; index += 1) {
    const value = BigInt(bytes[index]);
    number |= (value & 0x7fn) << shift;
    shift += 7n;
    if ((value & 0x80n) === 0n) return index === bytes.length - 1 ? number : null;
  }
  return null;
}

export function hasNoExternalAdmin(contract) {
  const number = selfAdminKeyNumber(contract?.admin_key?.key);
  return number !== null && `0.0.${number}` === contract.contract_id;
}

export function splitChunks(text, size) {
  if (typeof text !== "string" || text.length === 0) throw new Error("nothing to split");
  if (!Number.isInteger(size) || size < 1) throw new Error("chunk size must be a positive integer");
  const chunks = [];
  for (let offset = 0; offset < text.length; offset += size) chunks.push(text.slice(offset, offset + size));
  return chunks;
}

async function confirmed(transaction, client, what) {
  const response = await transaction.execute(client);
  const receipt = await response.getReceipt(client);
  if (receipt.status !== Status.Success) throw new Error(`${what} returned ${receipt.status}`);
  return { response, receipt };
}

export async function deployDetailed(client, artifact, parameters, gas, options = {}) {
  const chunks = splitChunks(hexBytecode(artifact.bytecode), options.chunkChars ?? DEFAULT_UPLOAD_CHUNK_CHARS);
  const operatorKey = client.operatorPublicKey;
  if (!operatorKey) throw new Error("the client has no operator");
  const created = await confirmed(new FileCreateTransaction().setKeys([operatorKey]).setContents(chunks[0]), client, "file create");
  const fileId = created.receipt.fileId;
  const uploads = [created.response.transactionId.toString()];
  try {
    for (const chunk of chunks.slice(1)) {
      const appended = await confirmed(new FileAppendTransaction().setFileId(fileId).setContents(chunk), client, "file append");
      uploads.push(appended.response.transactionId.toString());
    }
    const contractCreate = new ContractCreateTransaction().setBytecodeFileId(fileId).setGas(gas);
    if (parameters) contractCreate.setConstructorParameters(parameters);
    const deployed = await confirmed(contractCreate, client, "contract create");
    return { contractId: deployed.receipt.contractId, transactionId: deployed.response.transactionId.toString(), fileId: fileId.toString(), uploads, chunks: chunks.length };
  } finally {
    try {
      await confirmed(new FileDeleteTransaction().setFileId(fileId), client, "file delete");
    } catch {
      uploads.push(`file ${fileId} was not deleted`);
    }
  }
}

export async function deploy(client, artifact, parameters, gas, options = {}) {
  return (await deployDetailed(client, artifact, parameters, gas, options)).contractId;
}

export async function execute(client, contractId, name, parameters, options = {}) {
  const transaction = new ContractExecuteTransaction()
    .setContractId(contractId)
    .setGas(options.gas ?? 400_000)
    .setFunction(name, parameters ?? new ContractFunctionParameters());
  if (options.hbar) transaction.setPayableAmount(new Hbar(options.hbar));
  const result = await submit(client, transaction);
  const record = result.transactionId ? await recordOf(client, result.transactionId) : null;
  return { ...result, record, functionResult: record?.contractFunctionResult ?? null };
}

export async function call(client, contractId, name, parameters) {
  return new ContractCallQuery()
    .setContractId(contractId)
    .setGas(200_000)
    .setFunction(name, parameters ?? new ContractFunctionParameters())
    .execute(client);
}

export async function accountEvmAddress(config, accountId) {
  const body = await mirror(config, `/api/v1/accounts/${accountId}`);
  return { evmAddress: body.evm_address ?? null, keyType: body.key?._type ?? null };
}
