// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "./interfaces/IERC20.sol";
import {IPool, IAaveOracle, DataTypes} from "./interfaces/IAaveV3.sol";

/// @title SurvivalGuard — bounded, permissionless liquidation protection for Aave V3 borrowers
/// @notice A borrower pre-authorises a stablecoin buffer and a plan (trigger HF, target HF, cap, cooldown).
///         Anyone may call `protect(user)` once the user's on-chain health factor is below the trigger;
///         the contract pulls only what is needed from the buffer and repays the user's *own* Aave debt.
///         Funds pulled from the user can go to exactly two places: `POOL.repay(..., onBehalfOf = user)`
///         and a small keeper fee to `msg.sender`. There is no owner withdrawal and no upgradeability.
/// @dev    Not audited. Built for X Layer (Aave V3). See docs/contracts.md for the invariants this encodes.
contract SurvivalGuard {
    // ---------------------------------------------------------------- types
    struct Plan {
        address debtAsset; // Aave reserve to repay (variable rate)
        uint256 triggerHF; // 1e18-scaled; protect() only when hf < triggerHF
        uint256 targetHF; // 1e18-scaled; > triggerHF
        uint256 maxRepayPerProtect; // debtAsset units; cap per protect()
        uint32 cooldown; // seconds between protects
        bool active;
    }

    // ---------------------------------------------------------------- constants / immutables
    uint256 public constant WAD = 1e18;
    uint256 public constant BPS = 10_000;
    uint16 public constant MAX_FEE_BPS = 50; // 0.50%
    uint256 public constant MIN_TRIGGER_HF = 1.0e18; // protecting below liquidation makes no sense
    uint256 public constant MAX_TARGET_HF = 10e18; // sanity cap
    uint256 private constant VARIABLE_RATE = 2;

    IPool public immutable POOL;
    IAaveOracle public immutable ORACLE;

    // ---------------------------------------------------------------- state
    address public owner;
    uint16 public feeBps = 10; // 0.10% of repaid amount, paid to the keeper (msg.sender)
    bool public paused;

    mapping(address => Plan) internal _plans;
    mapping(address => uint40) public lastProtectAt;

    // ---------------------------------------------------------------- events
    event Enrolled(address indexed user, Plan plan);
    event Updated(address indexed user, Plan plan);
    event Disabled(address indexed user);
    event Protected(
        address indexed user,
        address indexed debtAsset,
        uint256 repaid,
        uint256 fee,
        uint256 hfBefore,
        uint256 hfAfter,
        address indexed keeper
    );
    event FeeUpdated(uint16 feeBps);
    event PausedSet(bool paused);
    event OwnerTransferred(address indexed previousOwner, address indexed newOwner);

    // ---------------------------------------------------------------- errors
    error NotOwner();
    error PausedError();
    error InvalidPlan(string reason);
    error NotActive();
    error Cooldown(uint256 availableAt);
    error HealthFactorAboveTrigger(uint256 hf, uint256 trigger);
    error NothingToRepay(string reason);
    error HealthFactorNotImproved(uint256 before, uint256 after_);
    error FeeTooHigh();
    error TransferFailed();

    // ---------------------------------------------------------------- constructor
    constructor(address pool, address oracle) {
        require(pool != address(0) && oracle != address(0), "zero address");
        POOL = IPool(pool);
        ORACLE = IAaveOracle(oracle);
        owner = msg.sender;
        emit OwnerTransferred(address(0), msg.sender);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    // ---------------------------------------------------------------- user actions
    /// @notice Create or replace the caller's plan. Caller must separately approve `debtAsset` to this contract.
    function enroll(Plan calldata plan) external {
        _validate(plan);
        bool existed = _plans[msg.sender].debtAsset != address(0);
        Plan memory p = plan;
        p.active = true;
        _plans[msg.sender] = p;
        if (existed) emit Updated(msg.sender, p);
        else emit Enrolled(msg.sender, p);
    }

    /// @notice Same as enroll; kept for UI clarity.
    function update(Plan calldata plan) external {
        _validate(plan);
        Plan memory p = plan;
        p.active = true;
        _plans[msg.sender] = p;
        emit Updated(msg.sender, p);
    }

    /// @notice Stop protection. Revoking the ERC-20 allowance has the same effect and is recommended too.
    function disable() external {
        Plan storage p = _plans[msg.sender];
        if (p.debtAsset == address(0)) revert NotActive();
        p.active = false;
        emit Disabled(msg.sender);
    }

    // ---------------------------------------------------------------- keeper action (permissionless)
    /// @notice Repay part of `user`'s debt from their pre-approved buffer if and only if their health factor
    ///         is below their trigger. Anyone may call. Fee (`feeBps` of repaid) goes to msg.sender.
    function protect(address user) external returns (uint256 repaid) {
        if (paused) revert PausedError();
        Plan memory p = _plans[user];
        if (!p.active) revert NotActive();

        uint256 availableAt = _availableAt(user, p.cooldown);
        if (block.timestamp < availableAt) revert Cooldown(availableAt);

        (uint256 hfBefore, uint256 amount, string memory reason) = _computeRepay(user, p);
        if (hfBefore >= p.triggerHF) revert HealthFactorAboveTrigger(hfBefore, p.triggerHF);
        if (amount == 0) revert NothingToRepay(reason);

        lastProtectAt[user] = uint40(block.timestamp);

        // pull the whole amount once; split into fee + repay
        if (!IERC20(p.debtAsset).transferFrom(user, address(this), amount)) revert TransferFailed();
        uint256 fee = (amount * feeBps) / BPS;
        repaid = amount - fee;

        _approve(p.debtAsset, address(POOL), repaid);
        uint256 actuallyRepaid = POOL.repay(p.debtAsset, repaid, VARIABLE_RATE, user);
        // Aave caps repayment at the outstanding debt; refund any dust to the user.
        if (actuallyRepaid < repaid) {
            if (!IERC20(p.debtAsset).transfer(user, repaid - actuallyRepaid)) revert TransferFailed();
            repaid = actuallyRepaid;
        }
        if (fee > 0 && !IERC20(p.debtAsset).transfer(msg.sender, fee)) revert TransferFailed();

        (,,,,, uint256 hfAfter) = POOL.getUserAccountData(user);
        if (hfAfter <= hfBefore) revert HealthFactorNotImproved(hfBefore, hfAfter);

        emit Protected(user, p.debtAsset, repaid, fee, hfBefore, hfAfter, msg.sender);
    }

    // ---------------------------------------------------------------- views
    function plans(address user) external view returns (Plan memory) {
        return _plans[user];
    }

    /// @notice What `protect(user)` would do right now, without reverting.
    function previewProtect(address user)
        external
        view
        returns (bool eligible, string memory reason, uint256 hf, uint256 repayAmount)
    {
        Plan memory p = _plans[user];
        if (paused) return (false, "paused", 0, 0);
        if (!p.active) return (false, "not active", 0, 0);
        (uint256 hfNow, uint256 amount, string memory why) = _computeRepay(user, p);
        if (block.timestamp < _availableAt(user, p.cooldown)) {
            return (false, "cooldown", hfNow, 0);
        }
        if (hfNow >= p.triggerHF) return (false, "health factor above trigger", hfNow, 0);
        if (amount == 0) return (false, why, hfNow, 0);
        return (true, "eligible", hfNow, amount);
    }

    // ---------------------------------------------------------------- owner
    function setFeeBps(uint16 bps) external onlyOwner {
        if (bps > MAX_FEE_BPS) revert FeeTooHigh();
        feeBps = bps;
        emit FeeUpdated(bps);
    }

    function setPaused(bool p) external onlyOwner {
        paused = p;
        emit PausedSet(p);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        emit OwnerTransferred(owner, newOwner);
        owner = newOwner;
    }

    // ---------------------------------------------------------------- internals
    function _validate(Plan calldata p) internal view {
        if (p.debtAsset == address(0)) revert InvalidPlan("debtAsset");
        if (p.triggerHF < MIN_TRIGGER_HF) revert InvalidPlan("triggerHF < 1.0");
        if (p.targetHF <= p.triggerHF) revert InvalidPlan("targetHF <= triggerHF");
        if (p.targetHF > MAX_TARGET_HF) revert InvalidPlan("targetHF > 10");
        if (p.maxRepayPerProtect == 0) revert InvalidPlan("maxRepayPerProtect");
        // debtAsset must be an Aave reserve with a variable debt token
        DataTypes.ReserveDataLegacy memory r = POOL.getReserveData(p.debtAsset);
        if (r.variableDebtTokenAddress == address(0)) revert InvalidPlan("not a reserve");
    }

    /// @dev Returns (hf, clamped repay amount, reason-if-zero). Pure computation, no state change.
    function _computeRepay(address user, Plan memory p)
        internal
        view
        returns (uint256 hf, uint256 amount, string memory reason)
    {
        uint256 wanted;
        (hf, wanted, reason) = _wantedRepay(user, p);
        if (wanted == 0) return (hf, 0, reason);
        (amount, reason) = _clamp(user, p, wanted);
    }

    /// @dev Ideal repay amount (debtAsset units) to lift HF to targetHF, before caps.
    function _wantedRepay(address user, Plan memory p)
        internal
        view
        returns (uint256 hf, uint256 amount, string memory reason)
    {
        (uint256 collateralBase, uint256 debtBase,, uint256 liqThresholdBps,, uint256 hfNow) =
            POOL.getUserAccountData(user);
        hf = hfNow;
        if (debtBase == 0) return (hf, 0, "no debt");
        // debt allowed at targetHF: collateral * LT / targetHF
        uint256 debtTargetBase = (collateralBase * liqThresholdBps * WAD) / (BPS * p.targetHF);
        if (debtBase <= debtTargetBase) return (hf, 0, "already above target");
        uint256 price = ORACLE.getAssetPrice(p.debtAsset); // base units per 1 token
        if (price == 0) return (hf, 0, "no price");
        amount = ((debtBase - debtTargetBase) * (10 ** IERC20(p.debtAsset).decimals())) / price;
        if (amount == 0) return (hf, 0, "rounding");
        return (hf, amount, "");
    }

    /// @dev min(wanted, plan cap, allowance, balance, outstanding variable debt) with a reason when it hits 0.
    function _clamp(address user, Plan memory p, uint256 wanted)
        internal
        view
        returns (uint256 amount, string memory reason)
    {
        amount = wanted > p.maxRepayPerProtect ? p.maxRepayPerProtect : wanted;
        IERC20 token = IERC20(p.debtAsset);
        uint256 allowance = token.allowance(user, address(this));
        if (allowance == 0) return (0, "no allowance");
        if (amount > allowance) amount = allowance;
        uint256 bal = token.balanceOf(user);
        if (bal == 0) return (0, "no buffer balance");
        if (amount > bal) amount = bal;
        uint256 debt = IERC20(POOL.getReserveData(p.debtAsset).variableDebtTokenAddress).balanceOf(user);
        if (debt == 0) return (0, "no variable debt in this asset");
        if (amount > debt) amount = debt;
        return (amount, "");
    }

    function _availableAt(address user, uint32 cooldown) internal view returns (uint256) {
        uint256 last = lastProtectAt[user];
        return last == 0 ? 0 : last + cooldown;
    }

    function _approve(address token, address spender, uint256 amount) internal {
        // USDT-style tokens require resetting to 0 first when allowance is non-zero.
        IERC20 t = IERC20(token);
        if (t.allowance(address(this), spender) != 0) t.approve(spender, 0);
        t.approve(spender, amount);
    }
}
