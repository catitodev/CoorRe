pragma solidity 0.8.28;

interface IPESEscrowV3 {
    struct Agreement {
        address producer;
        address funder;
        uint256 periodAmount;
        uint8 scoreThreshold;
        uint8 mode;
        bool active;
        uint256 deposited;
        uint256 released;
        uint256 refunded;
        uint256 committed;
    }

    struct Period {
        uint8 state;
        bytes32 auditHash;
        uint8 score;
        uint16 scoreVersion;
        address submitter;
        uint64 approvalDeadline;
    }

    function admin() external view returns (address);

    function getAgreement(uint256 agreementId) external view returns (Agreement memory);

    function getPeriod(uint256 agreementId, uint256 periodId) external view returns (Period memory);

    function approve(uint256 agreementId, uint256 periodId) external;

    function reject(uint256 agreementId, uint256 periodId) external;
}
