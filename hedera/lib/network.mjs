import { readFile } from "node:fs/promises";
import {
  AccountId,
  Client,
  ContractCallQuery,
  ContractCreateFlow,
  ContractExecuteTransaction,
  ContractFunctionParameters,
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

export async function deploy(client, artifact, parameters, gas) {
  const flow = new ContractCreateFlow().setBytecode(hexBytecode(artifact.bytecode)).setGas(gas);
  if (parameters) flow.setConstructorParameters(parameters);
  const response = await flow.execute(client);
  const receipt = await response.getReceipt(client);
  if (receipt.status !== Status.Success) throw new Error(`deploy returned ${receipt.status}`);
  return receipt.contractId;
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
