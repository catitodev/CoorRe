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
    uint8 public constant STATE_CLOSED_NO_PAY = 6;

    address public admin;
    address public pendingAdmin;
    address public financialManager;
    uint256 public approvalWindow;
    bool public paused;
    uint256 public agreementCount;

    mapping(address => bool) public isOracle;
    mapping(bytes32 => bool) public usedAuditHash;
    mapping(uint256 => Agreement) private agreements;
    mapping(uint256 => mapping(uint256 => Period)) private periods;

    error NotAdmin();
    error NotOracle();
    error NotFinancialManager();
    error NotPendingAdmin();
    error ZeroAddress();
    error ZeroValue();
    error InvalidParams();
    error AgreementNotFound();
    error AuditHashUsed();
    error InvalidState();
    error SameAccount();
    error DeadlinePassed();
    error DeadlineNotReached();
    error ContractPaused();
    error InsufficientFreeBalance();

    event FinancialManagerChanged(address indexed previousManager, address indexed newManager);
    event PeriodSubmitted(uint256 indexed agreementId, uint256 indexed periodId, bytes32 auditHash, uint8 score, uint8 state);
    event PeriodApproved(uint256 indexed agreementId, uint256 indexed periodId, address indexed approver);
    event PeriodRejected(uint256 indexed agreementId, uint256 indexed periodId, address indexed by);
    event PeriodExpired(uint256 indexed agreementId, uint256 indexed periodId);
    event ClosedNoPay(uint256 indexed agreementId, uint256 indexed periodId);
    event Deposited(uint256 indexed agreementId, address indexed from, uint256 amount);
    event Paused(address indexed by);
    event Unpaused(address indexed by);
    event AdminProposed(address indexed current, address indexed proposed);
    event AdminChanged(address indexed previousAdmin, address indexed newAdmin);

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier onlyFinancialManager() {
        if (msg.sender != financialManager) revert NotFinancialManager();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert ContractPaused();
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

    function deposit(uint256 agreementId) external payable whenNotPaused {
        Agreement storage a = _agreement(agreementId);
        if (msg.value == 0) revert ZeroValue();
        a.deposited += msg.value;
        emit Deposited(agreementId, msg.sender, msg.value);
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

    function pause() external onlyAdmin {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyAdmin {
        paused = false;
        emit Unpaused(msg.sender);
    }

    function proposeAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert ZeroAddress();
        pendingAdmin = newAdmin;
        emit AdminProposed(msg.sender, newAdmin);
    }

    function acceptAdmin() external {
        if (msg.sender != pendingAdmin) revert NotPendingAdmin();
        emit AdminChanged(admin, msg.sender);
        admin = msg.sender;
        pendingAdmin = address(0);
    }

    function submitBatch(uint256 agreementId, uint256 periodId, bytes32 auditHash, uint8 score, uint16 scoreVersion) external whenNotPaused {
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
            _commit(a);
            p.state = STATE_APPROVED;
        } else {
            p.state = STATE_PENDING_APPROVAL;
            p.approvalDeadline = uint64(block.timestamp + approvalWindow);
        }
        emit PeriodSubmitted(agreementId, periodId, auditHash, score, p.state);
    }

    function approve(uint256 agreementId, uint256 periodId) external onlyFinancialManager whenNotPaused {
        Agreement storage a = _agreement(agreementId);
        Period storage p = periods[agreementId][periodId];
        if (p.state != STATE_PENDING_APPROVAL) revert InvalidState();
        if (msg.sender == p.submitter) revert SameAccount();
        if (block.timestamp > p.approvalDeadline) revert DeadlinePassed();
        _commit(a);
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

    function closeNoPay(uint256 agreementId, uint256 periodId) external onlyAdmin {
        _agreement(agreementId);
        Period storage p = periods[agreementId][periodId];
        if (p.state != STATE_REJECTED && p.state != STATE_IN_REVIEW) revert InvalidState();
        p.state = STATE_CLOSED_NO_PAY;
        emit ClosedNoPay(agreementId, periodId);
    }

    function freeBalance(uint256 agreementId) external view returns (uint256) {
        return _free(_agreement(agreementId));
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

    function _free(Agreement storage a) private view returns (uint256) {
        return a.deposited - a.released - a.refunded - a.committed;
    }

    function _commit(Agreement storage a) private {
        if (_free(a) < a.periodAmount) revert InsufficientFreeBalance();
        a.committed += a.periodAmount;
    }
}
