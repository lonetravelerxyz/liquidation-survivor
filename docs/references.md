# Verified facts (trust over training data)

- X Layer mainnet: chainId 196, RPC `https://rpc.xlayer.tech`, explorer `https://web3.okx.com/explorer/x-layer`.
- X Layer testnet: chainId 1952, RPC `https://testrpc.xlayer.tech` (alt `https://xlayertestrpc.okx.com`),
  explorer `https://web3.okx.com/explorer/x-layer-testnet`, faucet `https://web3.okx.com/xlayer/faucet`.
  JSON-RPC batch limit ≈ 10 calls (observed 2026-08-18).
- Aave V3 on X Layer (bgd-labs/aave-address-book `AaveV3XLayer.sol`, verified via `cast` 2026-08-19):
  Pool `0xE3F3Caefdd7180F884c01E57f65Df979Af84f116`, AddressesProvider `0xdFf435BCcf782f11187D3a4454d96702eD78e092`,
  Oracle `0x91FC11136d5615575a0fC5981Ab5C0C54418E2C6` (base currency USD, 8 decimals),
  UiPoolDataProvider `0xc851e6147dcE6A469CC33BE3121b6B2D4CaD2763`, ProtocolDataProvider via address book.
  Reserves (underlying / aToken / vToken / decimals):
  USDT `0x779Ded0c9e1022225f8E0630b35a9b54bE713736` / `0xF356ae412dB5df43BD3a10746f7ad4e1C4De4297` / `0x04837866D0cb0cd2D8F60fBCa83B4a24b3a7c8ac` / 6
  USDG `0x4ae46a509F6b1D9056937BA4500cb143933D2dc8` / `0x228765a3C18065C923F23a0CCb6c7cEFB3eA2223` / `0xE6FC328D4DECB2Ae00E711743C04612ec963be46` / 6
  xBTC `0xb7C00000bcDEeF966b20B3D884B98E64d2b06b4f` / `0xF5F9d4e9e2AFe7E0b193d291Befb41d61930464e` / `0x5F874396f28dfdBd6bA2be80F52FD013Ce388C75` / 8
  WOKB `0xe538905cf8410324e03A5A23C1c177a474D59b2b` / `0x3ea3A4038FbA5757A9A68de920b44698d7326A59` / `0xb20752a1D7D16E54cBaad5137ba6C0a087752803` / 18
  xETH `0xE7B000003A45145decf8a28FC755aD5eC5EA025A` / `0xe6639ba6c1d79Be6d4c776E4c17504538d1719cD` / `0xB756Fc7065369602f2cCb8356283E8b997fDfe2a` / 18
  xSOL `0x505000008DE8748DBd4422ff4687a4FC9bEba15b` / `0x523dCe1b164327818fc5B41278fAe41f6B5753FE` / `0x4aF568Cb78Ade0e45E42f9B6d3deC0ff81E788af` / 9
  xBETH `0xAFeab3B85B6A56cF5F02317F0f7A23340eb983D7` / `0xe9e78053f1Ef084f8cD01dBE8ccE95c6b0944d32` / `0xe98AB0041B3BC09981D75A46aa78CC5e647a3906` / 18
  xOKSOL `0x14a686103854DAB7b8801E31979CAA595835B25d` / `0x38811564090aAb7bB455c5b771e26201a3535a01` / `0x3bEB61760eC29C2031843811dd5D51Bcbdb73B5e` / 9
  GHO `0xDe6539018B095353A40753Dc54C91C68c9487D4E` / `0x77188335A21f4C409d2CfeDe3195A7B5f28651b0` / `0x6a82EFFC620ec646429e8A1aE0E5DcC6C6ba30aA` / 18
  Note: Aave's "USDT" on X Layer is the USD₮0 contract (`0x779D…3736`).
- Aave V3 `getUserAccountData(user)` → (totalCollateralBase, totalDebtBase, availableBorrowsBase,
  currentLiquidationThreshold [bps], ltv [bps], healthFactor [1e18]); hf = max uint when no debt.
  `repay(asset, amount, interestRateMode=2, onBehalfOf)` is permissionless; amount > debt is capped to debt.
- Hackathon: BuildX AI Season, submissions until 2026-08-21 23:59 UTC; must deploy on X Layer testnet during
  the hackathon, mainnet later is encouraged; dedicated X account; submission tweet @XLayerOfficial; Google
  Form fields: name, description, URL, GitHub, email, Telegram, X handle, X post URL.
- Prior art: DeFi Saver (help.defisaver.com/automations/*), Summer.fi automation, Morpho pre-liquidation —
  see `../ai-season/research/liquidation-protection-refs.md` (outside this repo).
