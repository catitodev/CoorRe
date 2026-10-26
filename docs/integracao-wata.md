# Integração CoorRe on Hedera ↔ W.A.T.A. (proposta)

Este documento é uma **proposta** para o time da W.A.T.A. Nada aqui foi aplicado no repositório [vivipolli/wata](https://github.com/vivipolli/wata), nas contas ou nos contratos da W.A.T.A. O CoorRe leu o código da W.A.T.A. só para consulta, no commit `1462dfeb3d492893331dc5c0b0eae15d91ec807c`, fixado em [wata.lock.json](../hedera/reference/wata.lock.json).

O que roda hoje: o fluxo completo abaixo, numa rede Solo local na CI, contra o PESEscrowV3 compilado a partir desse commit com as configurações de compilação da W.A.T.A. (bytecode idêntico ao artefato versionado por ela). Nada roda na testnet ainda.

## O que o CoorRe faz e o que não faz

- O CoorRe responde por um único momento do processo: a decisão de aprovar ou rejeitar um período HYBRID em `PendingApproval`, tomada sob mandato e com prova pública.
- As regras de negócio continuam da W.A.T.A.: score, `scoreThreshold`, `periodAmount`, `approvalWindow`, prazos, tokenização. O CoorRe lê esses valores e nunca os define nem os altera.
- O PESEscrowV3 não muda. Nenhuma linha do contrato da W.A.T.A. precisa ser alterada.
- O CoorRe não guarda nem movimenta HBAR. Os fundos continuam no escrow, e o `release` continua como está.

Especificação completa: [docs/hedera/SPEC.md](hedera/SPEC.md). Ameaças e controles: [docs/hedera/THREAT_MODEL.md](hedera/THREAT_MODEL.md). Caminho de execução: [ADR-007](decisions/ADR-007-hedera-execution-path.md).

## A interface (adapter)

[hedera/adapter/wata.mjs](../hedera/adapter/wata.mjs), função `prepareDecision(input, context)`.

Entrada, toda produzida dentro da W.A.T.A.:

```json
{
  "hostId": "wata",
  "decisionPoint": "approve-or-reject-period",
  "agreementId": "0",
  "periodId": "1",
  "auditHash": "60e923175e060c671d4191c337ba6a6936e3c6120aa9a304e5918c51f33cdd8b",
  "score": 80,
  "scoreVersion": 1
}
```

Contexto: `network` (`solo` ou `testnet`), `escrow`, `gate` (só no caminho A), `mandateId`, `delegate` (endereço EVM de quem assina), `verdict` (`approve` ou `reject`), `mode` (`A` ou `B`).

Saída: só JSON, sem tipos de SDK. Traz `call.to`, `call.function`, `call.selector`, `call.abi`, `call.callData` (hex) e `call.value` (`"0"`); o `decisionDocument`, o `evidenceHash` (SHA-256 do JCS do documento), o `case_ref`/`case_id` e a `logMessage` (até 1024 bytes) para o tópico do CoorRe. O servidor nunca assina, como já acontece hoje na rota `POST /api/payments/approval-call/:agreementId` (`backend/src/routes/payments.ts:514-560`).

Observação: o adapter usa internamente `@hiero-ledger/sdk` 2.90.1 para montar o `callData`. A W.A.T.A. usa `@hashgraph/sdk`; como só JSON atravessa a interface, os dois não se misturam.

## O que a W.A.T.A. precisa definir antes

| Item | Onde entra |
|---|---|
| Endereço do PESEscrowV3 na testnet | `targets` do perfil ([wata.json](../hedera/host-profiles/wata.json)) |
| Contas delegadas (pessoas do financial manager) e, se houver, agentes com limite de autonomia | Documento do mandato |
| Validade de cada mandato (`validFrom`, `validUntil`) | Documento do mandato |
| Quórum (padrão 1) | Documento do mandato |
| Quem guarda a chave do operador do log do CoorRe | Decisão conjunta dos dois times |

## Passos propostos

### 1. Caminho B: registrar sem mudar nada on-chain

- A carteira do financial manager continua assinando `approve`/`reject` no escrow.
- A rota de approval-call passa a chamar `prepareDecision(..., { mode: "B" })` e devolve, além do `callData` de hoje, o `decisionDocument`, o `evidenceHash` e a `logMessage`.
- Depois da transação, a `logMessage` e o id da transação vão para o tópico HCS do CoorRe. O tópico atual da W.A.T.A. (`backend/src/services/hcs.ts:59-69`) continua como está.
- O que isso já prova: a carteira aprova com o `callData` do adapter, o evento `PeriodApproved` aponta a mesma conta nomeada na decisão, e a mensagem no Mirror Node é idêntica byte a byte à enviada (verificado no Solo).

### 2. Implantar o contrato do mandato

- `CoorReMandateGate` ([hedera/contracts/CoorReMandateGate.sol](../hedera/contracts/CoorReMandateGate.sol)) recebe só o endereço do escrow no construtor. Não é atualizável e não tem função pagável.
- Na testnet, a implantação e a verificação pública no HashScan gastam HBAR. Isso só acontece com a aprovação explícita dos mantenedores do CoorRe.

### 3. Registrar o mandato

- O admin do escrow (a conta 2-de-3, decisão D5) chama `registerMandate`. O `callData` sai de [hedera/lib/gate.mjs](../hedera/lib/gate.mjs).
- O documento completo do mandato vai para o tópico do CoorRe com o mesmo `mandateId`.

### 4. Apontar o financial manager para o contrato

- O admin 2-de-3 chama `setFinancialManager(<endereço do contrato>)`.
- A partir daí, a carteira que aprovava direto é recusada pelo escrow (`NotFinancialManager`), o que foi verificado no Solo.
- A troca fica pública no evento `FinancialManagerChanged` e é registrada no tópico do CoorRe.

### 5. Caminho A: decidir pelo contrato

- A rota de approval-call chama `prepareDecision(..., { mode: "A", gate })` e devolve `call.to` = contrato do mandato e `call.callData` de `decide(...)`.
- A carteira do delegado assina e envia. O contrato confere o mandato, a validade, o escopo, o período pendente, o `auditHash` do lote, o autor do lote e o quórum, e só então chama `approve` ou `reject` no escrow.
- Verificado no Solo: aprovação e rejeição pelo contrato, decisão repetida recusada, decisão sobre período em revisão recusada.

### 6. Períodos em revisão (InReview)

- Depois do prazo, qualquer conta pode chamar `expire`, e o período vai para `InReview`.
- O delegado registra no tópico um veredito de revisão: `resubmit` (com o motivo) ou `close-no-pay`.
- A W.A.T.A. executa: o oráculo reenvia com um novo `auditHash`, ou o admin chama `closeNoPay`.
- Verificado no Solo: período vencido, decisão recusada em revisão, veredito `resubmit` registrado e novo lote do oráculo voltando a `PendingApproval`.

### 7. Ações administrativas

- `setFinancialManager`, `setApprovalWindow`, `createAgreement`, `deactivateAgreement`, `closeNoPay`, `refund`, `withdrawExcess`, `pause`, `unpause`, `proposeAdmin` e `acceptAdmin` continuam com o admin da W.A.T.A.
- Cada uma é anunciada no tópico do CoorRe, e o verificador lista qualquer evento administrativo sem registro.

## Recomendações

- **Separação de funções:** hoje o papel `MANAGER` dispara o score (`backend/src/routes/oracle.ts:50,368,424`) e também pede a aprovação. Quem dispara o score não deve ser o delegado que aprova o pagamento.
- **Prazo:** a rota de approval-call compara o prazo com o relógio do servidor (`payments.ts:540`). Quem decide é o `block.timestamp`; no instante exato do prazo, `approve` ainda passa (`PESEscrowV3.sol:236`).
- **Unidade:** pelo SDK, o escrow registra valores em tinybar (verificado no Solo, provas P5). Isso resolve a nota "MUST be verified" de `PESEscrowV3.sol:14-16` para esse caminho. O caminho JSON-RPC das carteiras não foi testado aqui.

## Limites declarados

- Dois dos três admins podem tirar o CoorRe do papel de financial manager a qualquer momento. O CoorRe detecta isso (evento `FinancialManagerChanged`), mas não impede.
- O documento de auditoria fica no banco da W.A.T.A. O CoorRe prova qual documento a decisão nomeou, não que as medições sejam verdadeiras.
- As carteiras dos delegados foram simuladas no Solo com contas ECDSA assinando pelo SDK. O `msg.sender` é o mesmo de uma carteira EVM (prova P7), mas o envio por carteira via JSON-RPC (por exemplo, MetaMask pelo relay) não foi testado.

## Como conferir

Na pasta `hedera/`:

```bash
npm ci
```

```bash
npm run wata:fetch && npm run probes:compile && npm run build:contracts
```

```bash
npm test && npm run test:contracts && npm run check:protections
```

O fluxo no Solo roda na workflow `Hedera probes on Solo` (`.github/workflows/hedera-solo.yml`); o relatório fica no artefato `hedera-probe-report` (`integration/report.json`).
