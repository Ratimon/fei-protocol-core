pragma solidity ^0.6.0;
pragma experimental ABIEncoderV2;

import "./MockERC20.sol";

contract MockWeth is MockERC20 {
    constructor() public {}

    function deposit() external payable {
    	mint(msg.sender, msg.value);
    }
}
