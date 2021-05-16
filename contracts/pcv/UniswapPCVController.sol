pragma solidity ^0.6.0;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "@openzeppelin/contracts/math/Math.sol";
import "./IUniswapPCVController.sol";
import "../refs/UniRef.sol";
import "../external/UniswapV2Library.sol";
import "../utils/Timed.sol";

/// @title a IUniswapPCVController implementation for ETH
/// @author Fei Protocol
contract UniswapPCVController is IUniswapPCVController, UniRef, Timed {
    using Decimal for Decimal.D256;
    using SafeMathCopy for uint256;

    uint256 public override reweightWithdrawBPs = 9900;

    uint256 internal _reweightDuration = 4 hours;

    uint256 internal constant BASIS_POINTS_GRANULARITY = 10000;

    /// @notice returns the linked pcv deposit contract
    IPCVDeposit public override pcvDeposit;

    /// @notice gets the FEI reward incentive for reweighting
    uint256 public override reweightIncentiveAmount;
    Decimal.D256 internal _minDistanceForReweight;

    /// @notice EthUniswapPCVController constructor
    /// @param _core Fei Core for reference
    /// @param _pcvDeposit PCV Deposit to reweight
    /// @param _oracle oracle for reference
    /// @param _incentiveAmount amount of FEI for triggering a reweight
    /// @param _minDistanceForReweightBPs minimum distance from peg to reweight in basis points
    /// @param _pair Uniswap pair contract to reweight
    /// @param _router Uniswap Router
    constructor(
        address _core,
        address _pcvDeposit,
        address _oracle,
        uint256 _incentiveAmount,
        uint256 _minDistanceForReweightBPs,
        address _pair,
        address _router
    ) public UniRef(_core, _pair, _router, _oracle) Timed(_reweightDuration) {
        pcvDeposit = IPCVDeposit(_pcvDeposit);

        reweightIncentiveAmount = _incentiveAmount;
        _minDistanceForReweight = Decimal.ratio(
            _minDistanceForReweightBPs,
            BASIS_POINTS_GRANULARITY
        );

        // start timer
        _initTimed();
    }

    /// @notice reweights the linked PCV Deposit to the peg price. Needs to be reweight eligible
    function reweight() external override whenNotPaused {
        require(
            reweightEligible(),
            "EthUniswapPCVController: Not passed reweight time or not at min distance"
        );
        _reweight();
        _incentivize();
    }

    /// @notice reweights regardless of eligibility
    function forceReweight() external override onlyGuardianOrGovernor {
        _reweight();
    }

    /// @notice sets the target PCV Deposit address
    function setPCVDeposit(address _pcvDeposit) external override onlyGovernor {
        pcvDeposit = IPCVDeposit(_pcvDeposit);
        emit PCVDepositUpdate(_pcvDeposit);
    }

    /// @notice sets the reweight incentive amount
    function setReweightIncentive(uint256 amount)
        external
        override
        onlyGovernor
    {
        reweightIncentiveAmount = amount;
        emit ReweightIncentiveUpdate(amount);
    }

    /// @notice sets the reweight withdrawal BPs
    function setReweightWithdrawBPs(uint256 _reweightWithdrawBPs)
        external
        override
        onlyGovernor
    {
        require(_reweightWithdrawBPs <= BASIS_POINTS_GRANULARITY, "EthUniswapPCVController: withdraw percent too high");
        reweightWithdrawBPs = _reweightWithdrawBPs;
        emit ReweightWithdrawBPsUpdate(_reweightWithdrawBPs);
    }

    /// @notice sets the reweight min distance in basis points
    function setReweightMinDistance(uint256 basisPoints)
        external
        override
        onlyGovernor
    {
        _minDistanceForReweight = Decimal.ratio(
            basisPoints,
            BASIS_POINTS_GRANULARITY
        );
        emit ReweightMinDistanceUpdate(basisPoints);
    }

    /// @notice sets the reweight duration
    function setDuration(uint256 _duration)
        external
        override
        onlyGovernor
    {
       _setDuration(_duration);
    }

    /// @notice signal whether the reweight is available. Must have incentive parity and minimum distance from peg
    function reweightEligible() public view override returns (bool) {
        bool magnitude =
            _getDistanceToPeg().greaterThan(_minDistanceForReweight);
        // incentive parity is achieved after a certain time relative to distance from peg
        bool time = isTimeEnded();
        return magnitude && time;
    }

    /// @notice minimum distance as a percentage from the peg for a reweight to be eligible
    function minDistanceForReweight()
        external
        view
        override
        returns (Decimal.D256 memory)
    {
        return _minDistanceForReweight;
    }

    function _incentivize() internal ifMinterSelf {
        fei().mint(msg.sender, reweightIncentiveAmount);
    }

    function _reweight() internal {
        _withdraw();
        _returnToPeg();

        // resupply PCV at peg ratio
        IERC20 erc20 = IERC20(token);
        uint256 balance = erc20.balanceOf(address(this));

        SafeERC20.safeTransfer(erc20, address(pcvDeposit), balance);
        pcvDeposit.deposit(balance);

        _burnFeiHeld();

        // reset timer
        _initTimed();

        emit Reweight(msg.sender);
    }

    function _returnToPeg() internal {
        (uint256 feiReserves, uint256 tokenReserves) = getReserves();
        if (feiReserves == 0 || tokenReserves == 0) {
            return;
        }

        Decimal.D256 memory _peg = peg();

        if (_isBelowPeg(_peg)) {
            // calculate amount of token needed to return to peg then swap
            uint256 amount = _getAmountToPegOther(feiReserves, tokenReserves, _peg);

            IERC20 erc20 = IERC20(token);
            uint256 balance = erc20.balanceOf(address(this));
            
            amount = Math.min(amount, balance);

            SafeERC20.safeTransfer(erc20, address(pair), amount);

            _swap(token, amount, tokenReserves, feiReserves);
            
        } else {
            // calculate amount FEI needed to return to peg then swap
            uint256 amount = _getAmountToPegFei(feiReserves, tokenReserves, _peg);

            fei().mint(address(pair), amount);

            _swap(address(fei()), amount, feiReserves, tokenReserves);
        }
    }

    function _swap(
        address tokenIn,
        uint256 amount,
        uint256 reservesIn,
        uint256 reservesOut
    ) internal returns (uint256 amountOut) {

        amountOut = UniswapV2Library.getAmountOut(amount, reservesIn, reservesOut);

        (uint256 amount0Out, uint256 amount1Out) =
            pair.token0() == tokenIn
                ? (uint256(0), amountOut)
                : (amountOut, uint256(0));
        pair.swap(amount0Out, amount1Out, address(this), new bytes(0));
    }

    function _withdraw() internal {
        // Only withdraw a portion to prevent rounding errors on Uni LP dust
        uint256 value =
            pcvDeposit.totalValue().mul(reweightWithdrawBPs) /
                BASIS_POINTS_GRANULARITY;
        pcvDeposit.withdraw(address(this), value);
    }
}
