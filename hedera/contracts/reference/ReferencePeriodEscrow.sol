pragma solidity 0.8.28;

import {IPeriodEscrow} from "../IPeriodEscrow.sol";

contract ReferencePeriodEscrow is IPeriodEscrow {
    uint8 public constant MODE_AUTO = 0;
    uint8 public constant MODE_HYBRID = 1;
    uint8 public constant STATE_NONE = 0;
    uint8 public constant STATE_PENDING_APPROVAL = 1;
    uint8 public constant STATE_APPROVED = 2;
    uint8 public constant STATE_REJECTED = 4;
    uint8 public constant STATE_IN_REVIEW = 5;

    address public admin;
    address public financialManager;
    uint256 public approvalWindow;
    uint256 public agreementCount;

    mapping(address => bool) public isOracle;
    mapping(bytes32 => bool) public usedAuditHash;
    mapping(uint256 => Agreement) private agreements;
    mapping(uint256 => mapping(uint256 => Period)) private periods;

    error NotAdmin();
    error NotOracle();
    error NotFinancialManager();
    error ZeroAddress();
    error InvalidParams();
    error AgreementNotFound();
    error AuditHashUsed();
    error InvalidState();
    error SameAccount();
    error DeadlinePassed();
    error DeadlineNotReached();

    event FinancialManagerChanged(address indexed previousManager, address indexed newManager);
    event PeriodSubmitted(uint256 indexed agreementId, uint256 indexed periodId, bytes32 auditHash, uint8 score, uint8 state);
    event PeriodApproved(uint256 indexed agreementId, uint256 indexed periodId, address indexed approver);
    event PeriodRejected(uint256 indexed agreementId, uint256 indexed periodId, address indexed by);
    event PeriodExpired(uint256 indexed agreementId, uint256 indexed periodId);

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier onlyFinancialManager() {
        if (msg.sender != financialManager) revert NotFinancialManager();
        _;
    }

    constructor(address admin_, address financialManager_, uint256 approvalWindow_) {
        if (admin_ == address(0) || financialManager_ == address(0)) revert ZeroAddress();
        if (approvalWindow_ == 0) revert InvalidParams();
        admin = admin_;
        financialManager = financialManager_;
        approvalWindow = approvalWindow_;
    }

    function authorizeOracle(address oracle) external onlyAdmin {
        if (oracle == address(0)) revert ZeroAddress();
        isOracle[oracle] = true;
    }

    function createAgreement(address producer, uint256 periodAmount, uint8 scoreThreshold, uint8 mode) external onlyAdmin returns (uint256 agreementId) {
        if (producer == address(0)) revert ZeroAddress();
        if (periodAmount == 0 || scoreThreshold == 0 || scoreThreshold > 100 || mode > MODE_HYBRID) revert InvalidParams();
        agreementId = agreementCount++;
        Agreement storage a = agreements[agreementId];
        a.producer = producer;
        a.periodAmount = periodAmount;
        a.scoreThreshold = scoreThreshold;
        a.mode = mode;
        a.active = true;
    }

    function setFinancialManager(address newManager) external onlyAdmin {
        if (newManager == address(0)) revert ZeroAddress();
        emit FinancialManagerChanged(financialManager, newManager);
        financialManager = newManager;
    }

    function setApprovalWindow(uint256 newWindow) external onlyAdmin {
        if (newWindow == 0) revert InvalidParams();
        approvalWindow = newWindow;
    }

    function submitBatch(uint256 agreementId, uint256 periodId, bytes32 auditHash, uint8 score, uint16 scoreVersion) external {
        if (!isOracle[msg.sender]) revert NotOracle();
        Agreement storage a = _agreement(agreementId);
        if (score > 100) revert InvalidParams();
        if (usedAuditHash[auditHash]) revert AuditHashUsed();
        Period storage p = periods[agreementId][periodId];
        if (p.state != STATE_NONE && p.state != STATE_REJECTED && p.state != STATE_IN_REVIEW) revert InvalidState();
        usedAuditHash[auditHash] = true;
        p.auditHash = auditHash;
        p.score = score;
        p.scoreVersion = scoreVersion;
        p.submitter = msg.sender;
        if (score < a.scoreThreshold) {
            p.state = STATE_REJECTED;
        } else if (a.mode == MODE_AUTO) {
            p.state = STATE_APPROVED;
        } else {
            p.state = STATE_PENDING_APPROVAL;
            p.approvalDeadline = uint64(block.timestamp + approvalWindow);
        }
        emit PeriodSubmitted(agreementId, periodId, auditHash, score, p.state);
    }

    function approve(uint256 agreementId, uint256 periodId) external onlyFinancialManager {
        _agreement(agreementId);
        Period storage p = periods[agreementId][periodId];
        if (p.state != STATE_PENDING_APPROVAL) revert InvalidState();
        if (msg.sender == p.submitter) revert SameAccount();
        if (block.timestamp > p.approvalDeadline) revert DeadlinePassed();
        p.state = STATE_APPROVED;
        emit PeriodApproved(agreementId, periodId, msg.sender);
    }

    function reject(uint256 agreementId, uint256 periodId) external onlyFinancialManager {
        _agreement(agreementId);
        Period storage p = periods[agreementId][periodId];
        if (p.state != STATE_PENDING_APPROVAL) revert InvalidState();
        p.state = STATE_REJECTED;
        emit PeriodRejected(agreementId, periodId, msg.sender);
    }

    function expire(uint256 agreementId, uint256 periodId) external {
        _agreement(agreementId);
        Period storage p = periods[agreementId][periodId];
        if (p.state != STATE_PENDING_APPROVAL) revert InvalidState();
        if (block.timestamp <= p.approvalDeadline) revert DeadlineNotReached();
        p.state = STATE_IN_REVIEW;
        emit PeriodExpired(agreementId, periodId);
    }

    function getAgreement(uint256 agreementId) external view returns (Agreement memory) {
        return _agreement(agreementId);
    }

    function getPeriod(uint256 agreementId, uint256 periodId) external view returns (Period memory) {
        _agreement(agreementId);
        return periods[agreementId][periodId];
    }

    function _agreement(uint256 agreementId) private view returns (Agreement storage a) {
        if (agreementId >= agreementCount) revert AgreementNotFound();
        a = agreements[agreementId];
    }
}
