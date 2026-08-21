# SurvivalGuard — contract specification

Source: `contracts/src/SurvivalGuard.sol`. Tests: `contracts/test/`. Foundry project root: `contracts/`.

## Purpose

Let an Aave V3 borrower on X Layer pre-authorise a bounded, rule-based repayment of **their own debt** that
anyone can execute the moment their health factor drops below a threshold they chose. The contract is the
enforcement layer; the AI Sentinel only _recommends_ parameters and _calls_ `protect` earlier than a stranger
would. Nothing the operator runs can move user funds anywhere except into the user's own Aave debt.

## Invariants (tested)

1. `protect(user)` reverts unless the user's on-chain health factor (read from the Pool in the same tx) is
   strictly below `plan.triggerHF`.
2. Tokens pulled from the user via `transferFrom` go only to (a) `POOL.repay(asset, amt, 2, user)` and
   (b) the keeper fee (`feeBps` of the repaid amount, ≤ `MAX_FEE_BPS` = 50; **set to 0 on both deployments —
   protection is free**). No other destination exists.
3. The amount pulled is ≤ min(`plan.maxRepayPerProtect`, allowance, balance, user's variable debt in that asset,
   amount needed to reach `plan.targetHF`).
4. After repayment, `healthFactor` must be > before; otherwise revert (guards against a broken pool/oracle).
5. `cooldown` seconds must elapse between two protects of the same user.
6. The user can `disable()` at any time; the owner can `pause()` the whole contract (stops `protect`, never
   touches funds) and change `feeBps` only within the cap. No upgradeability, no rescue function for user funds.

## Interface

```solidity
struct Plan {
    address debtAsset;          // Aave reserve to repay (variable rate mode)
    uint256 triggerHF;          // 1e18-scaled, e.g. 1.15e18. protect() only when hf < triggerHF
    uint256 targetHF;           // 1e18-scaled, > triggerHF. repay enough to bring hf up to ~targetHF
    uint256 maxRepayPerProtect; // in debtAsset units; hard cap per protect() call
    uint32  cooldown;           // seconds between protects (default 300)
    bool    active;
}

event Enrolled(address indexed user, Plan plan);
event Updated(address indexed user, Plan plan);
event Disabled(address indexed user);
event Protected(address indexed user, address indexed debtAsset, uint256 repaid, uint256 fee,
                uint256 hfBefore, uint256 hfAfter, address indexed keeper);
event FeeUpdated(uint16 feeBps);
event Paused(bool paused);

function enroll(Plan calldata plan) external;        // creates or replaces the caller's plan (active = true)
function update(Plan calldata plan) external;        // alias kept for UI clarity; same as enroll
function disable() external;                         // sets active = false
function protect(address user) external returns (uint256 repaid);   // anyone; reverts per invariants
function previewProtect(address user) external view returns (
    bool eligible, string memory reason, uint256 hf, uint256 repayAmount);   // what protect() would do now
function plans(address user) external view returns (Plan memory);
function lastProtectAt(address user) external view returns (uint40);

// owner
function setFeeBps(uint16 bps) external;   // ≤ MAX_FEE_BPS
function setPaused(bool p) external;

// immutables
IPool  public immutable POOL;
IAaveOracle public immutable ORACLE;
```

## Repay-amount math

Aave: `hf = collateralBase * avgLiquidationThreshold / debtBase` (thresholds in bps, base currency = USD 1e8,
hf in 1e18). With `(c, d, _, lt, _, hf) = POOL.getUserAccountData(user)`:

```
debtTargetBase = c * lt / 1e4 * 1e18 / targetHF
repayBase      = d - debtTargetBase           (d > debtTargetBase whenever hf < targetHF)
repayAmount    = repayBase * 10^decimals(asset) / ORACLE.getAssetPrice(asset)
```

then clamp by `maxRepayPerProtect`, `allowance(user → guard)`, `balanceOf(user)`, and the user's variable debt
in `debtAsset` (`IERC20(getReserveData(asset).variableDebtTokenAddress).balanceOf(user)`). If the clamp yields 0,
revert `NothingToRepay`. Approximation is fine: the contract re-reads hf after repay and only requires it to
have increased; the keeper will call again after `cooldown` if still below trigger.

## Fee

`feeBps` of the repaid amount would be paid **to `msg.sender`** (the keeper) from the same `transferFrom`;
it is **set to 0 on both the testnet and mainnet deployments**, so protection is free and the full amount
goes to Aave repay. Anyone can run a keeper; our Sentinel is just the first one. Owner receives nothing.

## Errors

`NotActive`, `Cooldown`, `HealthFactorAboveTrigger`, `NothingToRepay`, `HealthFactorNotImproved`,
`InvalidPlan`, `PausedError`, `FeeTooHigh`.

## Deployments

| Network         | chainId | Pool                                                    | Guard                                        | Notes                                                                                                                                                                                                                                                                                                                              |
| --------------- | ------- | ------------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| X Layer mainnet | 196     | `0xE3F3Caefdd7180F884c01E57f65Df979Af84f116` (Aave V3)  | `0x838Bb12E48cb4Ff40A11BafC8E26855E2C8031B2` | oracle `0x91FC11136d5615575a0fC5981Ab5C0C54418E2C6`                                                                                                                                                                                                                                                                                |
| X Layer testnet | 1952    | `MockPool` `0x838Bb12E48cb4Ff40A11BafC8E26855E2C8031B2` | `0x63AC016d9393dA96b09f35D07cefc1D266015611` | MockPool + MockERC20s: USDT `0xe53823475E7ef96aa2b7B59606Db871b31DD8D17` (6), xETH `0x99C56cBB902c25E83BBae9004155491Ecc859B6f`, WOKB `0x49eE7DF998207248bcCBcC1b002AD22131037c83`, xBTC `0xd506DCC8F1a96B070395a6a801964212bb7250b0` (8); deployer/keeper `0xAE0ba6776F2164602f1e373B515bAc9be78a085d`; prices set by demo script |

## Mocks (`contracts/src/mocks/`)

- `MockERC20` — public `mint`. Decimals configurable.
- `MockPool` — implements the subset of `IPool` the guard uses (`getUserAccountData`, `repay`, `getReserveData`)
  plus demo helpers: `supply`, `borrow`, `setPrice`, `setLiquidationThreshold`. Also exposes
  `getAssetPrice` so it can be passed as the oracle. Health factor math mirrors Aave (bps thresholds, 1e8 base).
