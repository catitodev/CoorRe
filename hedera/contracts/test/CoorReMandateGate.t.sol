pragma solidity 0.8.28;

import {CheatCodes} from "./Vm.sol";
import {CoorReMandateGate} from "../CoorReMandateGate.sol";
import {IPESEscrowV3} from "../IPESEscrowV3.sol";
import {PESEscrowV3} from "../../.cache/wata/pinned/contracts/contracts/PESEscrowV3.sol";
import {OracleManager} from "../../.cache/wata/pinned/contracts/contracts/OracleManager.sol";

contract CoorReMandateGateTest is CheatCodes {
    uint64 internal constant START = 1_800_000_000;
    uint256 internal constant WINDOW = 3600;
    uint256 internal constant PERIOD_AMOUNT = 100_000_000;
    uint8 internal constant HYBRID = 1;
    uint8 internal constant AUTO = 0;

    address internal constant ORACLE = address(0xA11CE);
    address internal constant PRODUCER = address(0xB0B);
    address internal constant HUMAN = address(0xD1);
    address internal constant HUMAN_2 = address(0xD2);
    address internal constant AGENT = address(0xA6);
    address internal constant STRANGER = address(0x5);

    OracleManager internal oracles;
    PESEscrowV3 internal escrow;
    CoorReMandateGate internal gate;
    uint256 internal agreementId;
    bytes32 internal auditHash = keccak256("audit-1");
    bytes32 internal evidenceHash = keccak256("evidence-1");
    bytes32 internal mandateId = keccak256("mandate-1");

    function setUp() public {
        vm.warp(START);
        oracles = new OracleManager();
        oracles.authorizeOracle(ORACLE);
        escrow = new PESEscrowV3(address(oracles), address(this), address(0xF00D), WINDOW);
        gate = new CoorReMandateGate(address(escrow));
        escrow.setFinancialManager(address(gate));
        agreementId = escrow.createAgreement(PRODUCER, PERIOD_AMOUNT, 50, PESEscrowV3.GovernanceMode(HYBRID));
        vm.deal(address(this), 10 ether);
        escrow.deposit{value: 5 * PERIOD_AMOUNT}(agreementId);
        submit(1, auditHash);
    }

    function submit(uint256 periodId, bytes32 hash) internal {
        vm.prank(ORACLE);
        escrow.submitBatch(agreementId, periodId, hash, 80, 1);
    }

    function terms(uint8 quorum, bool hasLimit, uint256 limit) internal pure returns (CoorReMandateGate.MandateTerms memory) {
        return CoorReMandateGate.MandateTerms({
            validFrom: START,
            validUntil: START + 30 days,
            quorum: quorum,
            allAgreements: true,
            allowApprove: true,
            allowReject: true,
            hasAutonomyLimit: hasLimit,
            autonomyLimit: limit
        });
    }

    function register(bytes32 id, CoorReMandateGate.MandateTerms memory t, address[] memory delegates, uint8[] memory kinds) internal {
        gate.registerMandate(id, t, delegates, kinds, new uint256[](0));
    }

    function one(address a, uint8 kind) internal pure returns (address[] memory delegates, uint8[] memory kinds) {
        delegates = new address[](1);
        kinds = new uint8[](1);
        delegates[0] = a;
        kinds[0] = kind;
    }

    function registerHuman() internal {
        (address[] memory d, uint8[] memory k) = one(HUMAN, 1);
        register(mandateId, terms(1, false, 0), d, k);
    }

    function decideAs(address who, uint256 periodId, bytes32 hash, uint8 verdict) internal returns (bool) {
        vm.prank(who);
        return gate.decide(mandateId, agreementId, periodId, hash, verdict, evidenceHash);
    }

    function stateOf(uint256 periodId) internal view returns (uint8) {
        return uint8(escrow.getPeriod(agreementId, periodId).state);
    }

    function testHumanApprovalReachesTheEscrow() public {
        registerHuman();
        require(decideAs(HUMAN, 1, auditHash, 1), "executed");
        require(stateOf(1) == uint8(PESEscrowV3.PeriodState.Approved), "approved");
    }

    function testHumanRejectionReachesTheEscrow() public {
        registerHuman();
        decideAs(HUMAN, 1, auditHash, 2);
        require(stateOf(1) == uint8(PESEscrowV3.PeriodState.Rejected), "rejected");
    }

    function testOnlyTheEscrowAdminRegisters() public {
        (address[] memory d, uint8[] memory k) = one(HUMAN, 1);
        CoorReMandateGate.MandateTerms memory t = terms(1, false, 0);
        vm.prank(STRANGER);
        vm.expectRevert(CoorReMandateGate.NotIssuer.selector);
        gate.registerMandate(mandateId, t, d, k, new uint256[](0));
    }

    function testOnlyTheEscrowAdminRevokes() public {
        registerHuman();
        vm.prank(STRANGER);
        vm.expectRevert(CoorReMandateGate.NotIssuer.selector);
        gate.revokeMandate(mandateId);
    }

    function testAMandateIdCannotBeRegisteredTwice() public {
        registerHuman();
        (address[] memory d, uint8[] memory k) = one(HUMAN_2, 1);
        CoorReMandateGate.MandateTerms memory t = terms(1, false, 0);
        vm.expectRevert(CoorReMandateGate.MandateExists.selector);
        gate.registerMandate(mandateId, t, d, k, new uint256[](0));
    }

    function testInvalidTermsAreRefused() public {
        (address[] memory d, uint8[] memory k) = one(HUMAN, 1);
        CoorReMandateGate.MandateTerms memory t = terms(2, false, 0);
        vm.expectRevert(CoorReMandateGate.InvalidTerms.selector);
        gate.registerMandate(mandateId, t, d, k, new uint256[](0));
        t = terms(1, false, 0);
        t.validUntil = t.validFrom;
        vm.expectRevert(CoorReMandateGate.InvalidTerms.selector);
        gate.registerMandate(mandateId, t, d, k, new uint256[](0));
        t = terms(1, false, 7);
        vm.expectRevert(CoorReMandateGate.InvalidTerms.selector);
        gate.registerMandate(mandateId, t, d, k, new uint256[](0));
        t = terms(1, false, 0);
        t.allowApprove = false;
        t.allowReject = false;
        vm.expectRevert(CoorReMandateGate.InvalidTerms.selector);
        gate.registerMandate(mandateId, t, d, k, new uint256[](0));
        k[0] = 3;
        vm.expectRevert(CoorReMandateGate.InvalidTerms.selector);
        gate.registerMandate(mandateId, terms(1, false, 0), d, k, new uint256[](0));
    }

    function testDuplicateDelegatesAreRefused() public {
        address[] memory d = new address[](2);
        uint8[] memory k = new uint8[](2);
        d[0] = HUMAN;
        d[1] = HUMAN;
        k[0] = 1;
        k[1] = 1;
        CoorReMandateGate.MandateTerms memory t = terms(2, false, 0);
        vm.expectRevert(CoorReMandateGate.InvalidTerms.selector);
        gate.registerMandate(mandateId, t, d, k, new uint256[](0));
    }

    function testUnknownMandateIsRefused() public {
        vm.prank(HUMAN);
        vm.expectRevert(CoorReMandateGate.UnknownMandate.selector);
        gate.decide(keccak256("nope"), agreementId, 1, auditHash, 1, evidenceHash);
    }

    function testANonDelegateCannotDecide() public {
        registerHuman();
        vm.prank(STRANGER);
        vm.expectRevert(CoorReMandateGate.UnauthorizedActor.selector);
        gate.decide(mandateId, agreementId, 1, auditHash, 1, evidenceHash);
    }

    function testExpiredMandateIsRefused() public {
        registerHuman();
        vm.warp(START + 30 days + 1);
        vm.prank(HUMAN);
        vm.expectRevert(CoorReMandateGate.MandateNotActive.selector);
        gate.decide(mandateId, agreementId, 1, auditHash, 1, evidenceHash);
    }

    function testMandateBeforeItsStartIsRefused() public {
        (address[] memory d, uint8[] memory k) = one(HUMAN, 1);
        CoorReMandateGate.MandateTerms memory t = terms(1, false, 0);
        t.validFrom = START + 1;
        register(mandateId, t, d, k);
        vm.prank(HUMAN);
        vm.expectRevert(CoorReMandateGate.MandateNotActive.selector);
        gate.decide(mandateId, agreementId, 1, auditHash, 1, evidenceHash);
    }

    function testRevokedMandateIsRefused() public {
        registerHuman();
        gate.revokeMandate(mandateId);
        vm.prank(HUMAN);
        vm.expectRevert(CoorReMandateGate.MandateNotActive.selector);
        gate.decide(mandateId, agreementId, 1, auditHash, 1, evidenceHash);
    }

    function testAgreementOutsideTheListIsRefused() public {
        (address[] memory d, uint8[] memory k) = one(HUMAN, 1);
        CoorReMandateGate.MandateTerms memory t = terms(1, false, 0);
        t.allAgreements = false;
        uint256[] memory ids = new uint256[](1);
        ids[0] = agreementId + 1;
        gate.registerMandate(mandateId, t, d, k, ids);
        vm.prank(HUMAN);
        vm.expectRevert(CoorReMandateGate.OutOfScope.selector);
        gate.decide(mandateId, agreementId, 1, auditHash, 1, evidenceHash);
    }

    function testVerdictOutsideTheMandateIsRefused() public {
        (address[] memory d, uint8[] memory k) = one(HUMAN, 1);
        CoorReMandateGate.MandateTerms memory t = terms(1, false, 0);
        t.allowReject = false;
        register(mandateId, t, d, k);
        vm.prank(HUMAN);
        vm.expectRevert(CoorReMandateGate.OutOfScope.selector);
        gate.decide(mandateId, agreementId, 1, auditHash, 2, evidenceHash);
    }

    function testAutoAgreementIsOutOfScope() public {
        registerHuman();
        uint256 autoId = escrow.createAgreement(PRODUCER, PERIOD_AMOUNT, 50, PESEscrowV3.GovernanceMode(AUTO));
        vm.prank(HUMAN);
        vm.expectRevert(CoorReMandateGate.OutOfScope.selector);
        gate.decide(mandateId, autoId, 1, auditHash, 1, evidenceHash);
    }

    function testUnknownVerdictIsRefused() public {
        registerHuman();
        vm.prank(HUMAN);
        vm.expectRevert(CoorReMandateGate.InvalidVerdict.selector);
        gate.decide(mandateId, agreementId, 1, auditHash, 3, evidenceHash);
    }

    function testAPeriodNotPendingIsRefused() public {
        registerHuman();
        vm.prank(HUMAN);
        vm.expectRevert(CoorReMandateGate.PeriodNotPending.selector);
        gate.decide(mandateId, agreementId, 2, auditHash, 1, evidenceHash);
    }

    function testADecisionForAnotherBatchIsRefused() public {
        registerHuman();
        vm.prank(HUMAN);
        vm.expectRevert(CoorReMandateGate.AuditHashMismatch.selector);
        gate.decide(mandateId, agreementId, 1, keccak256("audit-other"), 1, evidenceHash);
    }

    function testADecisionCannotBeReplayedOnAResubmittedBatch() public {
        registerHuman();
        decideAs(HUMAN, 1, auditHash, 2);
        bytes32 second = keccak256("audit-2");
        submit(1, second);
        vm.prank(HUMAN);
        vm.expectRevert(CoorReMandateGate.AuditHashMismatch.selector);
        gate.decide(mandateId, agreementId, 1, auditHash, 2, evidenceHash);
        require(decideAs(HUMAN, 1, second, 1), "fresh decision on the new batch");
    }

    function testTheSubmitterCannotDecide() public {
        (address[] memory d, uint8[] memory k) = one(ORACLE, 1);
        register(mandateId, terms(1, false, 0), d, k);
        vm.prank(ORACLE);
        vm.expectRevert(CoorReMandateGate.SubmitterCannotDecide.selector);
        gate.decide(mandateId, agreementId, 1, auditHash, 1, evidenceHash);
    }

    function testQuorumWaitsForTheSecondDelegate() public {
        address[] memory d = new address[](2);
        uint8[] memory k = new uint8[](2);
        d[0] = HUMAN;
        d[1] = HUMAN_2;
        k[0] = 1;
        k[1] = 1;
        register(mandateId, terms(2, false, 0), d, k);
        require(!decideAs(HUMAN, 1, auditHash, 1), "first vote does not execute");
        require(stateOf(1) == uint8(PESEscrowV3.PeriodState.PendingApproval), "still pending");
        vm.prank(HUMAN);
        vm.expectRevert(CoorReMandateGate.AlreadyDecided.selector);
        gate.decide(mandateId, agreementId, 1, auditHash, 2, evidenceHash);
        require(decideAs(HUMAN_2, 1, auditHash, 1), "second vote executes");
        require(stateOf(1) == uint8(PESEscrowV3.PeriodState.Approved), "approved");
    }

    function testAnAgentApprovesWithinTheLimit() public {
        (address[] memory d, uint8[] memory k) = one(AGENT, 2);
        register(mandateId, terms(1, true, PERIOD_AMOUNT), d, k);
        require(decideAs(AGENT, 1, auditHash, 1), "executed");
        require(stateOf(1) == uint8(PESEscrowV3.PeriodState.Approved), "approved");
    }

    function testAnAgentAboveTheLimitIsMandateExceeded() public {
        (address[] memory d, uint8[] memory k) = one(AGENT, 2);
        register(mandateId, terms(1, true, PERIOD_AMOUNT - 1), d, k);
        vm.prank(AGENT);
        vm.expectRevert(CoorReMandateGate.MandateExceeded.selector);
        gate.decide(mandateId, agreementId, 1, auditHash, 1, evidenceHash);
    }

    function testAnAgentWithoutALimitIsMandateExceeded() public {
        (address[] memory d, uint8[] memory k) = one(AGENT, 2);
        register(mandateId, terms(1, false, 0), d, k);
        vm.prank(AGENT);
        vm.expectRevert(CoorReMandateGate.MandateExceeded.selector);
        gate.decide(mandateId, agreementId, 1, auditHash, 1, evidenceHash);
    }

    function testAnAgentCannotReject() public {
        (address[] memory d, uint8[] memory k) = one(AGENT, 2);
        register(mandateId, terms(1, true, PERIOD_AMOUNT), d, k);
        vm.prank(AGENT);
        vm.expectRevert(CoorReMandateGate.UnauthorizedActor.selector);
        gate.decide(mandateId, agreementId, 1, auditHash, 2, evidenceHash);
    }

    function testAHumanIsNotBoundByTheLimit() public {
        (address[] memory d, uint8[] memory k) = one(HUMAN, 1);
        register(mandateId, terms(1, true, 1), d, k);
        require(decideAs(HUMAN, 1, auditHash, 1), "executed");
    }

    function testApprovalAtTheDeadlinePassesAndOneSecondLaterTheEscrowRefuses() public {
        registerHuman();
        submit(2, keccak256("audit-3"));
        uint64 deadline = escrow.getPeriod(agreementId, 2).approvalDeadline;
        vm.warp(deadline);
        require(decideAs(HUMAN, 2, keccak256("audit-3"), 1), "at the deadline");
        vm.warp(deadline + 1);
        vm.prank(HUMAN);
        vm.expectRevert(PESEscrowV3.DeadlinePassed.selector);
        gate.decide(mandateId, agreementId, 1, auditHash, 1, evidenceHash);
    }

    function testTheEscrowRefusesAnyoneButTheGate() public {
        vm.prank(HUMAN);
        vm.expectRevert(PESEscrowV3.NotFinancialManager.selector);
        escrow.approve(agreementId, 1);
    }

    function testReentryFromTheEscrowIsRefused() public {
        ReenteringEscrow evil = new ReenteringEscrow(address(this));
        CoorReMandateGate evilGate = new CoorReMandateGate(address(evil));
        evil.setGate(evilGate);
        (address[] memory d, uint8[] memory k) = one(address(evil), 1);
        evilGate.registerMandate(mandateId, terms(1, false, 0), d, k, new uint256[](0));
        address[] memory d2 = new address[](1);
        d2[0] = HUMAN;
        (, uint8[] memory k2) = one(HUMAN, 1);
        evilGate.registerMandate(keccak256("mandate-2"), terms(1, false, 0), d2, k2, new uint256[](0));
        evil.arm(mandateId);
        vm.prank(HUMAN);
        evilGate.decide(keccak256("mandate-2"), 0, 1, auditHash, 1, evidenceHash);
        require(evil.reentryAttempted(), "reentry attempted");
        require(!evil.reentrySucceeded(), "reentry refused");
        require(evil.approvals() == 1, "one approval reached the escrow");
    }

    function testFuzzAgentLimit(uint256 limit) public {
        (address[] memory d, uint8[] memory k) = one(AGENT, 2);
        register(mandateId, terms(1, true, limit), d, k);
        vm.prank(AGENT);
        if (limit < PERIOD_AMOUNT) {
            vm.expectRevert(CoorReMandateGate.MandateExceeded.selector);
            gate.decide(mandateId, agreementId, 1, auditHash, 1, evidenceHash);
        } else {
            require(gate.decide(mandateId, agreementId, 1, auditHash, 1, evidenceHash), "executed");
        }
    }

    function testFuzzValidityWindow(uint64 offset) public {
        uint64 at = START + offset % uint64(60 days + 1);
        registerHuman();
        submit(2, keccak256("audit-fuzz"));
        vm.warp(at);
        bool inWindow = at <= START + 30 days;
        bool beforeDeadline = at <= escrow.getPeriod(agreementId, 2).approvalDeadline;
        vm.prank(HUMAN);
        if (!inWindow) {
            vm.expectRevert(CoorReMandateGate.MandateNotActive.selector);
            gate.decide(mandateId, agreementId, 2, keccak256("audit-fuzz"), 2, evidenceHash);
        } else if (beforeDeadline) {
            gate.decide(mandateId, agreementId, 2, keccak256("audit-fuzz"), 2, evidenceHash);
            require(stateOf(2) == uint8(PESEscrowV3.PeriodState.Rejected), "rejected");
        } else {
            gate.decide(mandateId, agreementId, 2, keccak256("audit-fuzz"), 2, evidenceHash);
            require(stateOf(2) == uint8(PESEscrowV3.PeriodState.Rejected), "reject has no deadline in the escrow");
        }
    }

    function testFuzzStrangersNeverDecide(address who) public {
        vm.assume(who != HUMAN);
        registerHuman();
        vm.prank(who);
        vm.expectRevert(CoorReMandateGate.UnauthorizedActor.selector);
        gate.decide(mandateId, agreementId, 1, auditHash, 1, evidenceHash);
    }
}

contract ReenteringEscrow {
    address public immutable adminAccount;
    CoorReMandateGate public gate;
    bytes32 public reentryMandate;
    bool public reentryAttempted;
    bool public reentrySucceeded;
    uint256 public approvals;

    constructor(address admin_) {
        adminAccount = admin_;
    }

    function setGate(CoorReMandateGate gate_) external {
        gate = gate_;
    }

    function arm(bytes32 mandateId) external {
        reentryMandate = mandateId;
    }

    function admin() external view returns (address) {
        return adminAccount;
    }

    function getAgreement(uint256) external pure returns (IPESEscrowV3.Agreement memory a) {
        a.mode = 1;
        a.periodAmount = 1;
    }

    function getPeriod(uint256, uint256) external pure returns (IPESEscrowV3.Period memory p) {
        p.state = 1;
        p.auditHash = keccak256("audit-1");
        p.submitter = address(0xA11CE);
    }

    function approve(uint256, uint256) external {
        approvals += 1;
        if (reentryMandate != bytes32(0) && !reentryAttempted) {
            reentryAttempted = true;
            try gate.decide(reentryMandate, 0, 1, keccak256("audit-1"), 1, keccak256("again")) {
                reentrySucceeded = true;
            } catch {
                reentrySucceeded = false;
            }
        }
    }

    function reject(uint256, uint256) external {}
}
