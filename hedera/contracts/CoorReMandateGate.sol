pragma solidity 0.8.28;

import {IPeriodEscrow} from "./IPeriodEscrow.sol";

contract CoorReMandateGate {
    uint8 public constant KIND_HUMAN = 1;
    uint8 public constant KIND_AGENT = 2;
    uint8 public constant VERDICT_APPROVE = 1;
    uint8 public constant VERDICT_REJECT = 2;
    uint8 public constant REVIEW_RESUBMIT = 1;
    uint8 public constant REVIEW_CLOSE_NO_PAY = 2;
    uint256 public constant MAX_DELEGATES = 20;
    uint256 public constant MAX_AGREEMENTS = 100;
    uint64 public constant MAX_BACKDATE = 1 days;
    uint8 private constant PERIOD_PENDING_APPROVAL = 1;
    uint8 private constant PERIOD_IN_REVIEW = 5;
    uint8 private constant MODE_HYBRID = 1;
    bytes32 private constant REVIEW_DOMAIN = keccak256("coorre.review");

    struct MandateTerms {
        uint64 validFrom;
        uint64 validUntil;
        uint8 quorum;
        bool allAgreements;
        bool allowApprove;
        bool allowReject;
        bool allowReview;
        bool hasAutonomyLimit;
        uint256 autonomyLimit;
    }

    struct Mandate {
        MandateTerms terms;
        address issuer;
        bool registered;
        bool revoked;
        uint64 revokedAt;
    }

    IPeriodEscrow public immutable escrow;
    uint64 public immutable maxValidity;

    mapping(bytes32 => Mandate) private mandates;
    mapping(bytes32 => mapping(address => uint8)) public delegateKind;
    mapping(bytes32 => mapping(uint256 => bool)) public agreementInScope;
    mapping(bytes32 => mapping(address => bool)) public hasDecided;
    mapping(bytes32 => uint8) public votes;
    mapping(bytes32 => bool) public executed;

    error ZeroAddress();
    error NotIssuer();
    error IssuerNotAdmin();
    error InvalidTerms();
    error MandateExists();
    error UnknownMandate();
    error MandateNotActive();
    error UnauthorizedActor();
    error OutOfScope();
    error PeriodNotPending();
    error PeriodNotInReview();
    error AuditHashMismatch();
    error DeadlinePassed();
    error SubmitterCannotDecide();
    error MandateExceeded();
    error AlreadyDecided();
    error InvalidVerdict();

    event MandateRegistered(bytes32 indexed mandateId, address indexed issuer, uint64 validFrom, uint64 validUntil, uint8 quorum);
    event MandateRevoked(bytes32 indexed mandateId, address indexed revoker, uint64 revokedAt);
    event DecisionAnchored(
        bytes32 indexed mandateId,
        uint256 indexed agreementId,
        uint256 indexed periodId,
        bytes32 auditHash,
        uint8 verdict,
        address delegate,
        uint8 kind,
        bytes32 evidenceHash,
        uint64 blockTimestamp,
        bool executedOnEscrow
    );
    event ReviewRecorded(
        bytes32 indexed mandateId,
        uint256 indexed agreementId,
        uint256 indexed periodId,
        bytes32 auditHash,
        uint8 outcome,
        address delegate,
        bytes32 evidenceHash,
        uint64 blockTimestamp,
        bool concluded
    );

    constructor(address escrow_, uint64 maxValidity_) {
        if (escrow_ == address(0)) revert ZeroAddress();
        if (maxValidity_ == 0) revert InvalidTerms();
        escrow = IPeriodEscrow(escrow_);
        maxValidity = maxValidity_;
    }

    function registerMandate(
        bytes32 mandateId,
        MandateTerms calldata terms,
        address[] calldata delegates,
        uint8[] calldata kinds,
        uint256[] calldata agreementIds
    ) external {
        if (msg.sender != escrow.admin()) revert NotIssuer();
        if (mandates[mandateId].registered) revert MandateExists();
        if (mandateId == bytes32(0)) revert InvalidTerms();
        if (terms.validFrom >= terms.validUntil) revert InvalidTerms();
        if (terms.validUntil <= block.timestamp) revert InvalidTerms();
        if (uint256(terms.validFrom) + MAX_BACKDATE < block.timestamp) revert InvalidTerms();
        if (terms.validUntil - terms.validFrom > maxValidity) revert InvalidTerms();
        if (!terms.allowApprove && !terms.allowReject && !terms.allowReview) revert InvalidTerms();
        if (delegates.length == 0 || delegates.length != kinds.length) revert InvalidTerms();
        if (delegates.length > MAX_DELEGATES) revert InvalidTerms();
        if (agreementIds.length > MAX_AGREEMENTS) revert InvalidTerms();
        if (terms.quorum == 0 || terms.quorum > delegates.length) revert InvalidTerms();
        if (terms.allAgreements == (agreementIds.length > 0)) revert InvalidTerms();
        if (!terms.hasAutonomyLimit && terms.autonomyLimit != 0) revert InvalidTerms();

        for (uint256 i = 0; i < delegates.length; i++) {
            if (delegates[i] == address(0)) revert ZeroAddress();
            if (kinds[i] != KIND_HUMAN && kinds[i] != KIND_AGENT) revert InvalidTerms();
            if (delegateKind[mandateId][delegates[i]] != 0) revert InvalidTerms();
            delegateKind[mandateId][delegates[i]] = kinds[i];
        }
        for (uint256 i = 0; i < agreementIds.length; i++) {
            agreementInScope[mandateId][agreementIds[i]] = true;
        }

        Mandate storage m = mandates[mandateId];
        m.terms = terms;
        m.issuer = msg.sender;
        m.registered = true;
        emit MandateRegistered(mandateId, msg.sender, terms.validFrom, terms.validUntil, terms.quorum);
    }

    function revokeMandate(bytes32 mandateId) external {
        Mandate storage m = mandates[mandateId];
        if (!m.registered) revert UnknownMandate();
        if (msg.sender != escrow.admin() && msg.sender != m.issuer) revert NotIssuer();
        if (m.revoked) revert MandateNotActive();
        m.revoked = true;
        m.revokedAt = uint64(block.timestamp);
        emit MandateRevoked(mandateId, msg.sender, m.revokedAt);
    }

    function decide(
        bytes32 mandateId,
        uint256 agreementId,
        uint256 periodId,
        bytes32 auditHash,
        uint8 verdict,
        bytes32 evidenceHash
    ) external returns (bool executedOnEscrow) {
        Mandate storage m = _active(mandateId);

        uint8 kind = delegateKind[mandateId][msg.sender];
        if (kind == 0) revert UnauthorizedActor();
        if (verdict != VERDICT_APPROVE && verdict != VERDICT_REJECT) revert InvalidVerdict();
        if (kind == KIND_AGENT && verdict != VERDICT_APPROVE) revert UnauthorizedActor();
        if (verdict == VERDICT_APPROVE && !m.terms.allowApprove) revert OutOfScope();
        if (verdict == VERDICT_REJECT && !m.terms.allowReject) revert OutOfScope();
        if (!m.terms.allAgreements && !agreementInScope[mandateId][agreementId]) revert OutOfScope();

        IPeriodEscrow.Agreement memory agreement = escrow.getAgreement(agreementId);
        if (agreement.mode != MODE_HYBRID) revert OutOfScope();

        IPeriodEscrow.Period memory period = escrow.getPeriod(agreementId, periodId);
        if (period.state != PERIOD_PENDING_APPROVAL) revert PeriodNotPending();
        if (period.auditHash != auditHash) revert AuditHashMismatch();
        if (block.timestamp > period.approvalDeadline) revert DeadlinePassed();
        if (period.submitter == msg.sender) revert SubmitterCannotDecide();

        if (kind == KIND_AGENT && (!m.terms.hasAutonomyLimit || agreement.periodAmount > m.terms.autonomyLimit)) {
            revert MandateExceeded();
        }

        executedOnEscrow = _vote(mandateId, keccak256(abi.encode(agreementId, periodId, auditHash)), verdict, m.terms.quorum);

        emit DecisionAnchored(
            mandateId, agreementId, periodId, auditHash, verdict, msg.sender, kind, evidenceHash, uint64(block.timestamp), executedOnEscrow
        );

        if (executedOnEscrow) {
            if (verdict == VERDICT_APPROVE) {
                escrow.approve(agreementId, periodId);
            } else {
                escrow.reject(agreementId, periodId);
            }
        }
    }

    function recordReview(
        bytes32 mandateId,
        uint256 agreementId,
        uint256 periodId,
        bytes32 auditHash,
        uint8 outcome,
        bytes32 evidenceHash
    ) external returns (bool concluded) {
        Mandate storage m = _active(mandateId);

        if (delegateKind[mandateId][msg.sender] != KIND_HUMAN) revert UnauthorizedActor();
        if (!m.terms.allowReview) revert OutOfScope();
        if (outcome != REVIEW_RESUBMIT && outcome != REVIEW_CLOSE_NO_PAY) revert InvalidVerdict();
        if (!m.terms.allAgreements && !agreementInScope[mandateId][agreementId]) revert OutOfScope();

        IPeriodEscrow.Agreement memory agreement = escrow.getAgreement(agreementId);
        if (agreement.mode != MODE_HYBRID) revert OutOfScope();

        IPeriodEscrow.Period memory period = escrow.getPeriod(agreementId, periodId);
        if (period.state != PERIOD_IN_REVIEW) revert PeriodNotInReview();
        if (period.auditHash != auditHash) revert AuditHashMismatch();
        if (period.submitter == msg.sender) revert SubmitterCannotDecide();

        concluded = _vote(mandateId, keccak256(abi.encode(REVIEW_DOMAIN, agreementId, periodId, auditHash)), outcome, m.terms.quorum);

        emit ReviewRecorded(mandateId, agreementId, periodId, auditHash, outcome, msg.sender, evidenceHash, uint64(block.timestamp), concluded);
    }

    function getMandate(bytes32 mandateId) external view returns (Mandate memory) {
        return mandates[mandateId];
    }

    function _active(bytes32 mandateId) private view returns (Mandate storage m) {
        m = mandates[mandateId];
        if (!m.registered) revert UnknownMandate();
        if (m.revoked || block.timestamp < m.terms.validFrom || block.timestamp > m.terms.validUntil) revert MandateNotActive();
        if (m.issuer != escrow.admin()) revert IssuerNotAdmin();
    }

    function _vote(bytes32 mandateId, bytes32 periodKey, uint8 choice, uint8 quorum) private returns (bool reached) {
        bytes32 ballotKey = keccak256(abi.encode(mandateId, periodKey));
        bytes32 voteKey = keccak256(abi.encode(ballotKey, choice));
        if (hasDecided[ballotKey][msg.sender] || executed[periodKey]) revert AlreadyDecided();

        hasDecided[ballotKey][msg.sender] = true;
        uint8 count = votes[voteKey] + 1;
        votes[voteKey] = count;
        reached = count >= quorum;
        if (reached) executed[periodKey] = true;
    }
}
