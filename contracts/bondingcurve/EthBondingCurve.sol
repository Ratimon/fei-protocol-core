pragma solidity ^0.6.0;
pragma experimental ABIEncoderV2;

import "./BondingCurve.sol";
import "../pcv/IPCVDeposit.sol";

contract EthBondingCurve is BondingCurve {

	constructor(
		uint256 scale, 
		address core, 
		address[] memory allocations, 
		uint16[] memory ratios, 
		address oracle
	)
		BondingCurve(scale, core, allocations, ratios, oracle)
	public {}

	function purchase(uint256 amountIn, address to) public override payable returns (uint256 amountOut) {
		require(msg.value == amountIn, "Bonding Curve: Sent value does not equal input");
		return _purchase(amountIn, to);
	}

	// Represents the integral solved for upper bound of P(x) = X/S * O
	// TODO update to P(x) = sqrt(X/S) * O or other appropriate sublinear function
	function getBondingCurveAmountOut(uint256 amountIn) public view override returns (uint256 amountOut) {
		uint256 radicand = (2 * amountIn * scale()) + (totalPurchased() * totalPurchased());
		return radicand.sqrt() - totalPurchased();
	}

	function allocateSingle(uint256 amount, address pcvDeposit) internal override {
		IPCVDeposit(pcvDeposit).deposit{value : amount}(amount);
	}

}

