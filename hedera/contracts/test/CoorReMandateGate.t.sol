pragma solidity 0.8.28;

import {CheatCodes} from "./Vm.sol";
import {CoorReMandateGate} from "../CoorReMandateGate.sol";
import {IPeriodEscrow} from "../IPeriodEscrow.sol";
import {ReferencePeriodEscrow} from "../reference/ReferencePeriodEscrow.sol";

contract CoorReMandateGateTest is CheatCodes {
    uint64 internal constant START = 1_800_000_000;
    uint256 internal constant WINDOW = 3600;
    uint256 internal constant PERIOD_AMOUNT = 100_000_000;
    uint64 internal constant MAX_VALIDITY = 90 days;
    uint8 internal constant HYBRID = 1;
    uint8 internal constant AUTO = 0;

    address internal constant ORACLE = address(0xA11CE);
    address internal constant PRODUCER = address(0xB0B);
    address internal constant HUMAN = address(0xD1);
    address internal constant HUMAN_2 = address(0xD2);
    address internal constant AGENT = address(0xA6);
    address internal constant STRANGER = address(0x5);
    address internal constant NEW_ADMIN = address(0xADD1);

    ReferencePeriodEscrow internal escrow;
    CoorReMandateGate internal gate;
    uint256 internal agreementId;
    bytes32 internal auditHash = keccak256("audit-1");
    bytes32 internal evidenceHash = keccak256("evidence-1");
    bytes32 internal mandateId = keccak256("mandate-1");

    function setUp() public {
        vm.warp(START);
        escrow = new ReferencePeriodEscrow(address(this), address(0xF00D), WINDOW);
        escrow.authorizeOracle(ORACLE);
        gate = new CoorReMandateGate(address(escrow), MAX_VALIDITY);
        escrow.setFinancialManager(address(gate));
        agreementId = escrow.createAgreement(PRODUCER, PERIOD_AMOUNT, 50, HYBRID);
        vm.deal(address(this), 100 ether);
        escrow.deposit{value: 5 * PERIOD_AMOUNT}(agreementId);
        submit(1, auditHash);
    }

    function submitFor(uint256 agId, uint256 periodId, bytes32 hash) internal {
        vm.prank(ORACLE);
        escrow.submitBatch(agId, periodId, hash, 80, 1);
    }

    function submit(uint256 periodId, bytes32 hash) internal {
        submitFor(agreementId, periodId, hash);
    }

    function terms(uint8 quorum, bool hasLimit, uint256 limit) internal pure returns (CoorReMandateGate.MandateTerms memory) {
        return CoorReMandateGate.MandateTerms({
            validFrom: START,
            validUntil: START + 30 days,
            quorum: quorum,
            allAgreements: true,
            allowApprove: true,
            allowReject: true,
            allowReview: false,
            hasAutonomyLimit: hasLimit,
            autonomyLimit: limit
        });
    }

    function termsWithReview(uint8 quorum) internal pure returns (CoorReMandateGate.MandateTerms memory t) {
        t = terms(quorum, false, 0);
        t.allowReview = true;
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

    function two(address a, address b) internal pure returns (address[] memory delegates, uint8[] memory kinds) {
        delegates = new address[](2);
        kinds = new uint8[](2);
        delegates[0] = a;
        delegates[1] = b;
        kinds[0] = 1;
        kinds[1] = 1;
    }

    function registerHuman() internal {
        (address[] memory d, uint8[] memory k) = one(HUMAN, 1);
        register(mandateId, terms(1, false, 0), d, k);
    }

    function registerPair(uint8 quorum, bool review) internal {
        (address[] memory d, uint8[] memory k) = two(HUMAN, HUMAN_2);
        register(mandateId, review ? termsWithReview(quorum) : terms(quorum, false, 0), d, k);
    }

    function decideAs(address who, uint256 periodId, bytes32 hash, uint8 verdict) internal returns (bool) {
        vm.prank(who);
        return gate.decide(mandateId, agreementId, periodId, hash, verdict, evidenceHash);
    }

    function reviewAs(address who, uint256 periodId, bytes32 hash, uint8 outcome) internal returns (bool) {
        vm.prank(who);
        return gate.recordReview(mandateId, agreementId, periodId, hash, outcome, evidenceHash);
    }

    function stateOf(uint256 periodId) internal view returns (uint8) {
        return escrow.getPeriod(agreementId, periodId).state;
    }

    function ballotFor(uint256 agId, uint256 periodId, bytes32 hash) internal view returns (bytes32) {
        return keccak256(abi.encode(mandateId, keccak256(abi.encode(agId, periodId, hash))));
    }

    function toReview(uint256 periodId) internal {
        vm.warp(escrow.getPeriod(agreementId, periodId).approvalDeadline + 1);
        escrow.expire(agreementId, periodId);
    }

    function changeAdmin() internal {
        escrow.proposeAdmin(NEW_ADMIN);
        vm.prank(NEW_ADMIN);
        escrow.acceptAdmin();
    }

    function testHumanApprovalReachesTheEscrow() public {
        registerHuman();
        require(decideAs(HUMAN, 1, auditHash, 1), "executed");
        require(stateOf(1) == escrow.STATE_APPROVED(), "approved");
    }

    function testHumanRejectionReachesTheEscrow() public {
        registerHuman();
        decideAs(HUMAN, 1, auditHash, 2);
        require(stateOf(1) == escrow.STATE_REJECTED(), "rejected");
    }

    function testConstructorRefusesZeroValues() public {
        vm.expectRevert(CoorReMandateGate.ZeroAddress.selector);
        new CoorReMandateGate(address(0), MAX_VALIDITY);
        vm.expectRevert(CoorReMandateGate.InvalidTerms.selector);
        new CoorReMandateGate(address(escrow), 0);
    }

    function testOnlyTheEscrowAdminRegisters() public {
        (address[] memory d, uint8[] memory k) = one(HUMAN, 1);
        CoorReMandateGate.MandateTerms memory t = terms(1, false, 0);
        vm.prank(STRANGER);
        vm.expectRevert(CoorReMandateGate.NotIssuer.selector);
        gate.registerMandate(mandateId, t, d, k, new uint256[](0));
    }

    function testOnlyTheIssuerOrTheAdminRevokes() public {
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

    function testAMandateCannotStartAfterItEnds() public {
        (address[] memory d, uint8[] memory k) = one(HUMAN, 1);
        CoorReMandateGate.MandateTerms memory t = terms(1, false, 0);
        t.validFrom = START + 2 days;
        t.validUntil = START + 1 days;
        vm.expectRevert(CoorReMandateGate.InvalidTerms.selector);
        gate.registerMandate(mandateId, t, d, k, new uint256[](0));
    }

    function testAMandateWithOnlyReviewIsValid() public {
        (address[] memory d, uint8[] memory k) = one(HUMAN, 1);
        CoorReMandateGate.MandateTerms memory t = termsWithReview(1);
        t.allowApprove = false;
        t.allowReject = false;
        register(mandateId, t, d, k);
        require(gate.getMandate(mandateId).registered, "registered");
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

    function testMandateDurationAboveTheCapIsRefused() public {
        (address[] memory d, uint8[] memory k) = one(HUMAN, 1);
        CoorReMandateGate.MandateTerms memory t = terms(1, false, 0);
        t.validUntil = START + MAX_VALIDITY;
        register(mandateId, t, d, k);
        t.validUntil = START + MAX_VALIDITY + 1;
        vm.expectRevert(CoorReMandateGate.InvalidTerms.selector);
        gate.registerMandate(keccak256("mandate-long"), t, d, k, new uint256[](0));
    }

    function testAMandateAlreadyExpiredIsRefused() public {
        vm.warp(START + 10 days);
        (address[] memory d, uint8[] memory k) = one(HUMAN, 1);
        CoorReMandateGate.MandateTerms memory t = terms(1, false, 0);
        t.validFrom = START + 10 days - 2 hours;
        t.validUntil = START + 10 days - 1 hours;
        vm.expectRevert(CoorReMandateGate.InvalidTerms.selector);
        gate.registerMandate(mandateId, t, d, k, new uint256[](0));
    }

    function testAMandateBackdatedTooFarIsRefused() public {
        vm.warp(START + 5 days);
        (address[] memory d, uint8[] memory k) = one(HUMAN, 1);
        CoorReMandateGate.MandateTerms memory t = terms(1, false, 0);
        t.validUntil = START + 6 days;
        vm.expectRevert(CoorReMandateGate.InvalidTerms.selector);
        gate.registerMandate(mandateId, t, d, k, new uint256[](0));
        t.validFrom = START + 4 days;
        register(mandateId, t, d, k);
    }

    function testTooManyDelegatesAreRefused() public {
        address[] memory d = new address[](21);
        uint8[] memory k = new uint8[](21);
        for (uint256 i = 0; i < 21; i++) {
            d[i] = address(uint160(0x1000 + i));
            k[i] = 1;
        }
        CoorReMandateGate.MandateTerms memory t = terms(1, false, 0);
        vm.expectRevert(CoorReMandateGate.InvalidTerms.selector);
        gate.registerMandate(mandateId, t, d, k, new uint256[](0));
        address[] memory d20 = new address[](20);
        uint8[] memory k20 = new uint8[](20);
        for (uint256 i = 0; i < 20; i++) {
            d20[i] = d[i];
            k20[i] = 1;
        }
        register(mandateId, t, d20, k20);
    }

    function testTooManyAgreementsAreRefused() public {
        (address[] memory d, uint8[] memory k) = one(HUMAN, 1);
        uint256[] memory ids = new uint256[](101);
        for (uint256 i = 0; i < 101; i++) ids[i] = i;
        CoorReMandateGate.MandateTerms memory t = terms(1, false, 0);
        t.allAgreements = false;
        vm.expectRevert(CoorReMandateGate.InvalidTerms.selector);
        gate.registerMandate(mandateId, t, d, k, ids);
        uint256[] memory ids100 = new uint256[](100);
        for (uint256 i = 0; i < 100; i++) ids100[i] = i;
        gate.registerMandate(mandateId, t, d, k, ids100);
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

    function testAMandateCannotBeRevokedTwice() public {
        registerHuman();
        gate.revokeMandate(mandateId);
        vm.expectRevert(CoorReMandateGate.MandateNotActive.selector);
        gate.revokeMandate(mandateId);
    }

    function testDecisionIsRefusedAfterTheAdminChanges() public {
        registerHuman();
        changeAdmin();
        vm.prank(HUMAN);
        vm.expectRevert(CoorReMandateGate.IssuerNotAdmin.selector);
        gate.decide(mandateId, agreementId, 1, auditHash, 1, evidenceHash);
    }

    function testTheOriginalIssuerCanStillRevokeAfterTheAdminChanges() public {
        registerHuman();
        changeAdmin();
        gate.revokeMandate(mandateId);
        require(gate.getMandate(mandateId).revoked, "revoked");
    }

    function testTheNewAdminCanRevokeAnInheritedMandate() public {
        registerHuman();
        changeAdmin();
        vm.prank(NEW_ADMIN);
        gate.revokeMandate(mandateId);
        require(gate.getMandate(mandateId).revoked, "revoked");
    }

    function testTheNewAdminRegistersAMandateAndDecides() public {
        registerHuman();
        changeAdmin();
        bytes32 second = keccak256("mandate-2");
        (address[] memory d, uint8[] memory k) = one(HUMAN, 1);
        vm.prank(NEW_ADMIN);
        gate.registerMandate(second, terms(1, false, 0), d, k, new uint256[](0));
        vm.prank(HUMAN);
        require(gate.decide(second, agreementId, 1, auditHash, 1, evidenceHash), "executed");
        require(stateOf(1) == escrow.STATE_APPROVED(), "approved");
    }

    function testAMandateWorksAgainIfTheAdminComesBack() public {
        registerHuman();
        changeAdmin();
        vm.prank(NEW_ADMIN);
        escrow.proposeAdmin(address(this));
        escrow.acceptAdmin();
        require(decideAs(HUMAN, 1, auditHash, 1), "executed");
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
        uint256 autoId = escrow.createAgreement(PRODUCER, PERIOD_AMOUNT, 50, AUTO);
        vm.prank(HUMAN);
        vm.expectRevert(CoorReMandateGate.OutOfScope.selector);
        gate.decide(mandateId, autoId, 1, auditHash, 1, evidenceHash);
    }

    function testUnknownAgreementIsRefusedByTheEscrow() public {
        registerHuman();
        vm.prank(HUMAN);
        vm.expectRevert(ReferencePeriodEscrow.AgreementNotFound.selector);
        gate.decide(mandateId, 99, 1, auditHash, 1, evidenceHash);
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
        registerPair(2, false);
        require(!decideAs(HUMAN, 1, auditHash, 1), "first vote does not execute");
        require(stateOf(1) == escrow.STATE_PENDING_APPROVAL(), "still pending");
        vm.prank(HUMAN);
        vm.expectRevert(CoorReMandateGate.AlreadyDecided.selector);
        gate.decide(mandateId, agreementId, 1, auditHash, 2, evidenceHash);
        require(decideAs(HUMAN_2, 1, auditHash, 1), "second vote executes");
        require(stateOf(1) == escrow.STATE_APPROVED(), "approved");
    }

    function testDelegatesWhoDisagreeLeaveThePeriodToTheDeadlineAndNothingIsPaid() public {
        registerPair(2, false);
        require(!decideAs(HUMAN, 1, auditHash, 1), "approve vote");
        require(!decideAs(HUMAN_2, 1, auditHash, 2), "reject vote");
        require(stateOf(1) == escrow.STATE_PENDING_APPROVAL(), "still pending");
        toReview(1);
        require(stateOf(1) == escrow.STATE_IN_REVIEW(), "in review");
        require(escrow.getAgreement(agreementId).committed == 0, "nothing committed");
    }

    function testPartialVotesSurviveAChangeOfFinancialManagerAndBack() public {
        registerPair(2, false);
        require(!decideAs(HUMAN, 1, auditHash, 1), "first vote");
        escrow.setFinancialManager(address(0xBEEF));
        escrow.setFinancialManager(address(gate));
        require(decideAs(HUMAN_2, 1, auditHash, 1), "second vote completes the quorum");
        require(stateOf(1) == escrow.STATE_APPROVED(), "approved");
    }

    function testADelegateIsReplacedByRevokingAndRegisteringANewMandate() public {
        registerHuman();
        gate.revokeMandate(mandateId);
        bytes32 second = keccak256("mandate-2");
        (address[] memory d, uint8[] memory k) = one(HUMAN_2, 1);
        register(second, terms(1, false, 0), d, k);
        vm.prank(HUMAN);
        vm.expectRevert(CoorReMandateGate.MandateNotActive.selector);
        gate.decide(mandateId, agreementId, 1, auditHash, 1, evidenceHash);
        vm.prank(HUMAN_2);
        vm.expectRevert(CoorReMandateGate.MandateNotActive.selector);
        gate.decide(mandateId, agreementId, 1, auditHash, 1, evidenceHash);
        vm.prank(HUMAN_2);
        require(gate.decide(second, agreementId, 1, auditHash, 1, evidenceHash), "executed");
    }

    function testAnAgentApprovesWithinTheLimit() public {
        (address[] memory d, uint8[] memory k) = one(AGENT, 2);
        register(mandateId, terms(1, true, PERIOD_AMOUNT), d, k);
        require(decideAs(AGENT, 1, auditHash, 1), "executed");
        require(stateOf(1) == escrow.STATE_APPROVED(), "approved");
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

    function testApprovalAndRejectionPassAtTheLastSecondOfTheDeadline() public {
        registerHuman();
        bytes32 second = keccak256("audit-2");
        submit(2, second);
        uint64 deadline = escrow.getPeriod(agreementId, 1).approvalDeadline;
        vm.warp(deadline);
        require(decideAs(HUMAN, 1, auditHash, 1), "approved at the deadline");
        require(decideAs(HUMAN, 2, second, 2), "rejected at the deadline");
        require(stateOf(1) == escrow.STATE_APPROVED(), "period 1 approved");
        require(stateOf(2) == escrow.STATE_REJECTED(), "period 2 rejected");
    }

    function testApprovalAndRejectionAreRefusedOneSecondAfterTheDeadline() public {
        registerHuman();
        bytes32 second = keccak256("audit-2");
        submit(2, second);
        vm.warp(escrow.getPeriod(agreementId, 1).approvalDeadline + 1);
        vm.prank(HUMAN);
        vm.expectRevert(CoorReMandateGate.DeadlinePassed.selector);
        gate.decide(mandateId, agreementId, 1, auditHash, 1, evidenceHash);
        vm.prank(HUMAN);
        vm.expectRevert(CoorReMandateGate.DeadlinePassed.selector);
        gate.decide(mandateId, agreementId, 2, second, 2, evidenceHash);
    }

    function testAPartialVoteAfterTheDeadlineIsRefusedAndNothingIsStored() public {
        registerPair(2, false);
        vm.warp(escrow.getPeriod(agreementId, 1).approvalDeadline + 1);
        vm.prank(HUMAN);
        vm.expectRevert(CoorReMandateGate.DeadlinePassed.selector);
        gate.decide(mandateId, agreementId, 1, auditHash, 1, evidenceHash);
        require(!gate.hasDecided(ballotFor(agreementId, 1, auditHash), HUMAN), "no vote stored");
    }

    function testARejectionAfterTheDeadlineIsRefusedAndExpireLeadsToReview() public {
        registerHuman();
        vm.warp(escrow.getPeriod(agreementId, 1).approvalDeadline + 1);
        vm.prank(HUMAN);
        vm.expectRevert(CoorReMandateGate.DeadlinePassed.selector);
        gate.decide(mandateId, agreementId, 1, auditHash, 2, evidenceHash);
        escrow.expire(agreementId, 1);
        require(stateOf(1) == escrow.STATE_IN_REVIEW(), "in review");
    }

    function testApprovalWithThePausedEscrowRevertsWholeAndStoresNoVote() public {
        registerHuman();
        escrow.pause();
        vm.prank(HUMAN);
        vm.expectRevert(ReferencePeriodEscrow.ContractPaused.selector);
        gate.decide(mandateId, agreementId, 1, auditHash, 1, evidenceHash);
        require(!gate.hasDecided(ballotFor(agreementId, 1, auditHash), HUMAN), "no vote stored");
        escrow.unpause();
        require(decideAs(HUMAN, 1, auditHash, 1), "executed after the pause");
    }

    function testRejectionWithThePausedEscrowExecutes() public {
        registerHuman();
        escrow.pause();
        require(decideAs(HUMAN, 1, auditHash, 2), "executed");
        require(stateOf(1) == escrow.STATE_REJECTED(), "rejected");
    }

    function testApprovalWithoutFreeBalanceRevertsWholeUntilTheAgreementIsFunded() public {
        registerHuman();
        uint256 empty = escrow.createAgreement(PRODUCER, PERIOD_AMOUNT, 50, HYBRID);
        bytes32 hash = keccak256("audit-empty");
        submitFor(empty, 1, hash);
        vm.prank(HUMAN);
        vm.expectRevert(ReferencePeriodEscrow.InsufficientFreeBalance.selector);
        gate.decide(mandateId, empty, 1, hash, 1, evidenceHash);
        require(!gate.hasDecided(ballotFor(empty, 1, hash), HUMAN), "no vote stored");
        escrow.deposit{value: PERIOD_AMOUNT}(empty);
        vm.prank(HUMAN);
        require(gate.decide(mandateId, empty, 1, hash, 1, evidenceHash), "executed after the deposit");
    }

    function testAPeriodInReviewIsClosedWithoutPaymentAndTheGateStaysOut() public {
        registerHuman();
        toReview(1);
        escrow.closeNoPay(agreementId, 1);
        require(stateOf(1) == escrow.STATE_CLOSED_NO_PAY(), "closed");
        vm.prank(HUMAN);
        vm.expectRevert(CoorReMandateGate.PeriodNotPending.selector);
        gate.decide(mandateId, agreementId, 1, auditHash, 1, evidenceHash);
    }

    function testAPeriodInReviewResubmittedWithANewHashNeedsADecisionOnTheNewHash() public {
        registerHuman();
        toReview(1);
        bytes32 second = keccak256("audit-resubmitted");
        submit(1, second);
        require(stateOf(1) == escrow.STATE_PENDING_APPROVAL(), "pending again");
        vm.prank(HUMAN);
        vm.expectRevert(CoorReMandateGate.AuditHashMismatch.selector);
        gate.decide(mandateId, agreementId, 1, auditHash, 1, evidenceHash);
        require(decideAs(HUMAN, 1, second, 1), "decision on the new hash");
    }

    function testAReviewIsRecordedForAPeriodInReview() public {
        registerPair(1, true);
        toReview(1);
        require(reviewAs(HUMAN, 1, auditHash, 1), "concluded");
        require(stateOf(1) == escrow.STATE_IN_REVIEW(), "the gate does not move the period");
    }

    function testAReviewNeedsThePermissionInTheMandate() public {
        registerHuman();
        toReview(1);
        vm.prank(HUMAN);
        vm.expectRevert(CoorReMandateGate.OutOfScope.selector);
        gate.recordReview(mandateId, agreementId, 1, auditHash, 1, evidenceHash);
    }

    function testAReviewOnAnAutoAgreementIsOutOfScope() public {
        registerPair(1, true);
        uint256 autoId = escrow.createAgreement(PRODUCER, PERIOD_AMOUNT, 50, AUTO);
        vm.prank(HUMAN);
        vm.expectRevert(CoorReMandateGate.OutOfScope.selector);
        gate.recordReview(mandateId, autoId, 1, auditHash, 1, evidenceHash);
    }

    function testAReviewOutsideTheAgreementListIsRefused() public {
        (address[] memory d, uint8[] memory k) = one(HUMAN, 1);
        CoorReMandateGate.MandateTerms memory t = termsWithReview(1);
        t.allAgreements = false;
        uint256[] memory ids = new uint256[](1);
        ids[0] = agreementId + 1;
        gate.registerMandate(mandateId, t, d, k, ids);
        toReview(1);
        vm.prank(HUMAN);
        vm.expectRevert(CoorReMandateGate.OutOfScope.selector);
        gate.recordReview(mandateId, agreementId, 1, auditHash, 1, evidenceHash);
    }

    function testAReviewOfAPendingPeriodIsRefused() public {
        registerPair(1, true);
        vm.prank(HUMAN);
        vm.expectRevert(CoorReMandateGate.PeriodNotInReview.selector);
        gate.recordReview(mandateId, agreementId, 1, auditHash, 1, evidenceHash);
    }

    function testAnAgentCannotRecordAReview() public {
        (address[] memory d, uint8[] memory k) = one(AGENT, 2);
        register(mandateId, termsWithReview(1), d, k);
        toReview(1);
        vm.prank(AGENT);
        vm.expectRevert(CoorReMandateGate.UnauthorizedActor.selector);
        gate.recordReview(mandateId, agreementId, 1, auditHash, 1, evidenceHash);
    }

    function testAReviewOutcomeMustBeKnown() public {
        registerPair(1, true);
        toReview(1);
        vm.prank(HUMAN);
        vm.expectRevert(CoorReMandateGate.InvalidVerdict.selector);
        gate.recordReview(mandateId, agreementId, 1, auditHash, 3, evidenceHash);
    }

    function testAReviewForAnotherBatchIsRefused() public {
        registerPair(1, true);
        toReview(1);
        vm.prank(HUMAN);
        vm.expectRevert(CoorReMandateGate.AuditHashMismatch.selector);
        gate.recordReview(mandateId, agreementId, 1, keccak256("audit-other"), 1, evidenceHash);
    }

    function testTheSubmitterCannotRecordAReview() public {
        (address[] memory d, uint8[] memory k) = one(ORACLE, 1);
        register(mandateId, termsWithReview(1), d, k);
        toReview(1);
        vm.prank(ORACLE);
        vm.expectRevert(CoorReMandateGate.SubmitterCannotDecide.selector);
        gate.recordReview(mandateId, agreementId, 1, auditHash, 1, evidenceHash);
    }

    function testAReviewNeedsTheQuorumAndEachDelegateRecordsOnce() public {
        registerPair(2, true);
        toReview(1);
        require(!reviewAs(HUMAN, 1, auditHash, 2), "first record does not conclude");
        vm.prank(HUMAN);
        vm.expectRevert(CoorReMandateGate.AlreadyDecided.selector);
        gate.recordReview(mandateId, agreementId, 1, auditHash, 2, evidenceHash);
        require(reviewAs(HUMAN_2, 1, auditHash, 2), "second record concludes");
    }

    function testAReviewAfterTheAdminChangesIsRefused() public {
        registerPair(1, true);
        toReview(1);
        changeAdmin();
        vm.prank(HUMAN);
        vm.expectRevert(CoorReMandateGate.IssuerNotAdmin.selector);
        gate.recordReview(mandateId, agreementId, 1, auditHash, 1, evidenceHash);
    }

    function testReentryFromTheEscrowIsRefused() public {
        ReenteringEscrow evil = new ReenteringEscrow(address(this));
        CoorReMandateGate evilGate = new CoorReMandateGate(address(evil), MAX_VALIDITY);
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

    function testFuzzMandateWindow(uint64 offset) public {
        uint64 at = START + offset % uint64(60 days + 1);
        registerHuman();
        vm.warp(at);
        vm.prank(HUMAN);
        if (at > START + 30 days) {
            vm.expectRevert(CoorReMandateGate.MandateNotActive.selector);
        } else if (at > START + WINDOW) {
            vm.expectRevert(CoorReMandateGate.DeadlinePassed.selector);
        }
        gate.decide(mandateId, agreementId, 1, auditHash, 2, evidenceHash);
    }

    function testFuzzDeadline(uint64 offset) public {
        uint64 at = START + offset % uint64(2 * WINDOW);
        registerHuman();
        vm.warp(at);
        vm.prank(HUMAN);
        if (at > START + WINDOW) vm.expectRevert(CoorReMandateGate.DeadlinePassed.selector);
        gate.decide(mandateId, agreementId, 1, auditHash, 1, evidenceHash);
    }

    function testFuzzStrangersNeverDecide(address who) public {
        vm.assume(who != HUMAN);
        registerHuman();
        vm.prank(who);
        vm.expectRevert(CoorReMandateGate.UnauthorizedActor.selector);
        gate.decide(mandateId, agreementId, 1, auditHash, 1, evidenceHash);
    }

    function testFuzzNoDecisionOutsideTheAuthority(bool revoke, bool adminChanges, uint64 offset) public {
        registerHuman();
        if (revoke) gate.revokeMandate(mandateId);
        if (adminChanges) changeAdmin();
        uint64 at = START + offset % uint64(120 days);
        vm.warp(at);
        vm.prank(HUMAN);
        try gate.decide(mandateId, agreementId, 1, auditHash, 1, evidenceHash) returns (bool) {
            require(!revoke, "decided with a revoked mandate");
            require(!adminChanges, "decided with an issuer that is not the admin");
            require(at <= START + 30 days, "decided after the mandate ended");
            require(at <= START + WINDOW, "decided after the deadline");
        } catch {}
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

    function getAgreement(uint256) external pure returns (IPeriodEscrow.Agreement memory a) {
        a.mode = 1;
        a.periodAmount = 1;
    }

    function getPeriod(uint256, uint256) external pure returns (IPeriodEscrow.Period memory p) {
        p.state = 1;
        p.auditHash = keccak256("audit-1");
        p.submitter = address(0xA11CE);
        p.approvalDeadline = type(uint64).max;
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
