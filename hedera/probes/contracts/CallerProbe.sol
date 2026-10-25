pragma solidity 0.8.28;

interface IPeriodDecision {
    function approve(uint256 agreementId, uint256 periodId) external;
    function reject(uint256 agreementId, uint256 periodId) external;
}

contract CallerProbe {
    error NotFinancialManager();
    error DeadlinePassed();
    error SameAccount();

    function observe() external payable returns (address sender, address origin, uint256 value, uint256 timestamp, uint256 blockNumber) {
        return (msg.sender, tx.origin, msg.value, block.timestamp, block.number);
    }

    function approveOn(address escrow, uint256 agreementId, uint256 periodId) external {
        IPeriodDecision(escrow).approve(agreementId, periodId);
    }

    function rejectOn(address escrow, uint256 agreementId, uint256 periodId) external {
        IPeriodDecision(escrow).reject(agreementId, periodId);
    }

    function errorSelectors() external pure returns (bytes4 notFinancialManager, bytes4 deadlinePassed, bytes4 sameAccount) {
        return (NotFinancialManager.selector, DeadlinePassed.selector, SameAccount.selector);
    }
}
