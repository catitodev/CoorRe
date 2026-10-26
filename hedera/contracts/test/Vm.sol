pragma solidity 0.8.28;

interface Vm {
    function prank(address sender) external;

    function startPrank(address sender) external;

    function stopPrank() external;

    function warp(uint256 timestamp) external;

    function deal(address account, uint256 balance) external;

    function expectRevert(bytes4 selector) external;

    function expectRevert(bytes calldata data) external;

    function assume(bool condition) external;
}

abstract contract CheatCodes {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
}
