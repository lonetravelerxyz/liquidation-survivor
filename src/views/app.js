// Liquidation Survivor — app page. Vanilla JS + viem (ESM CDN). No build step.
import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  formatUnits,
  http,
  isAddress,
  maxUint256,
  parseAbi,
  parseUnits,
} from "https://esm.sh/viem@2";

// ------------------------------------------------------------------ ABIs (human-readable)
const GUARD_ABI = parseAbi([
  "struct Plan { address debtAsset; uint256 triggerHF; uint256 targetHF; uint256 maxRepayPerProtect; uint32 cooldown; bool active; }",
  "function enroll(Plan plan)",
  "function disable()",
  "function plans(address user) view returns (Plan)",
  "function previewProtect(address user) view returns (bool eligible, string reason, uint256 hf, uint256 repayAmount)",
  "function lastProtectAt(address user) view returns (uint40)",
  "function feeBps() view returns (uint16)",
  "function paused() view returns (bool)",
]);
const ERC20_ABI = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
  "function mint(address to, uint256 amount)",
]);
const POOL_ABI = parseAbi([
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
  "function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)",
  "function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)",
]);

// ------------------------------------------------------------------ state
const S = {
  cfg: null,
  chain: null,
  provider: null,
  pub: null,
  wallet: null,
  account: null,
  position: null,
  plan: null,
  reco: null,
  stables: [],
  reserves: [],
};

const $ = (id) => document.getElementById(id);
const UINT_MAX = maxUint256;

// ------------------------------------------------------------------ helpers
const dash = "—";
const has = (v) => v !== undefined && v !== null && v !== "";
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : dash);
const fmtUsd = (v) => {
  const n = Number(v);
  if (!has(v) || !Number.isFinite(n)) return dash;
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: n < 10 ? 4 : 2,
  });
};
const fmtNum = (v, d = 4) => {
  const n = Number(v);
  if (!has(v) || !Number.isFinite(n)) return dash;
  return n.toLocaleString("en-US", { maximumFractionDigits: d });
};
const fmtHf = (v) => {
  if (!has(v)) return dash;
  if (v === "inf" || v === Infinity || v === "∞") return "∞";
  const n = Number(v);
  if (!Number.isFinite(n)) return dash;
  return n > 1e6 ? "∞" : n.toFixed(2);
};
const hfColor = (hf) => (!has(hf) || hf === Infinity || hf >= 1.5 ? "green" : hf >= 1.2 ? "amber" : "red");
const wadToNum = (w) => {
  if (typeof w !== "bigint") return has(w) ? Number(w) : null;
  if (w >= UINT_MAX / 2n) return Infinity;
  return Number(w) / 1e18;
};
const fmtTs = (ts) => {
  if (!has(ts)) return dash;
  const n = Number(ts);
  const d = new Date(n < 1e12 ? n * 1000 : n);
  return Number.isNaN(d.getTime()) ? String(ts) : d.toLocaleString();
};
const explorer = (kind, v) => {
  const base = (S.cfg && S.cfg.explorerBase) || "";
  return base ? `${base}/${kind}/${v}` : "#";
};
const link = (kind, v, text) =>
  `<a href="${explorer(kind, v)}" target="_blank" rel="noopener" class="mono">${text || short(v)}</a>`;
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

function msg(text, kind = "") {
  const el = $("globalMsg");
  if (!text) return el.classList.add("hidden");
  el.className = `alert ${kind}`;
  el.textContent = text;
}
function log(containerId, html, kind = "") {
  const el = $(containerId);
  const item = document.createElement("div");
  item.className = `item ${kind}`;
  item.innerHTML = html;
  el.prepend(item);
  return item;
}
const errText = (e) => {
  const m = e?.shortMessage || e?.details || e?.message || String(e);
  return m.length > 220 ? m.slice(0, 220) + "…" : m;
};
async function api(path, opts) {
  const r = await fetch(path, { headers: { "content-type": "application/json" }, ...opts });
  if (!r.ok) {
    let detail = "";
    try {
      detail = (await r.json()).error || "";
    } catch {
      /* ignore */
    }
    throw new Error(`${path} → ${r.status}${detail ? ` (${detail})` : ""}`);
  }
  return r.json();
}
const reserveOf = (addrOrSym) =>
  S.reserves.find(
    (r) => r.address?.toLowerCase() === String(addrOrSym).toLowerCase() || r.symbol === addrOrSym,
  ) || null;
const decimalsOf = (addr) => reserveOf(addr)?.decimals ?? 18;
const symbolOf = (addr) => reserveOf(addr)?.symbol ?? (addr ? short(addr) : "");
const fmtUnits = (v, addr, d = 4) => {
  if (!has(v)) return dash;
  try {
    return `${fmtNum(formatUnits(BigInt(v), decimalsOf(addr)), d)} ${symbolOf(addr)}`;
  } catch {
    return `${v} ${symbolOf(addr)}`;
  }
};
const setEnabled = (ids, on) => ids.forEach((id) => ($(id).disabled = !on));

// ------------------------------------------------------------------ config
function normalizeConfig(raw) {
  const c = raw || {};
  const chainId = Number(c.chainId ?? (c.chain === "mainnet" ? 196 : 1952));
  const reserves = (c.reserves || []).map((r) => ({
    symbol: r.symbol,
    address: r.address,
    decimals: Number(r.decimals ?? 18),
    priceUsd: r.priceUsd ?? r.price ?? null,
    isStable: r.isStable ?? r.stable ?? ["USDT", "USDG", "GHO", "USDC"].includes(r.symbol),
  }));
  return {
    chainId,
    chainName: chainId === 196 ? "X Layer" : "X Layer Testnet",
    rpcUrl: c.rpcUrl || (chainId === 196 ? "https://rpc.xlayer.tech" : "https://testrpc.xlayer.tech"),
    explorerBase:
      c.explorerBase ||
      (chainId === 196
        ? "https://web3.okx.com/explorer/x-layer"
        : "https://web3.okx.com/explorer/x-layer-testnet"),
    guardAddress: c.guardAddress || c.guard || "",
    poolAddress: c.poolAddress || c.pool || "",
    feeBps: c.feeBps ?? 10,
    telegramBotUsername: c.telegramBotUsername || c.telegramBot || "",
    aiEnabled: c.aiEnabled ?? true,
    reserves,
  };
}

async function loadConfig() {
  try {
    S.cfg = normalizeConfig(await api("/api/config"));
  } catch (e) {
    S.cfg = normalizeConfig({});
    msg(
      `Could not load /api/config (${errText(e)}). Showing defaults; the server may still be starting.`,
      "warn",
    );
  }
  const c = S.cfg;
  S.reserves = c.reserves;
  S.stables = c.reserves.filter((r) => r.isStable);
  S.chain = defineChain({
    id: c.chainId,
    name: c.chainName,
    nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
    rpcUrls: { default: { http: [c.rpcUrl] } },
    blockExplorers: { default: { name: "OKX Explorer", url: c.explorerBase } },
    testnet: c.chainId !== 196,
  });
  S.pub = createPublicClient({ chain: S.chain, transport: http(c.rpcUrl) });

  $("netName").textContent = `${c.chainName} ${c.chainId}`;
  $("netBadge").classList.add(c.chainId === 196 ? "ok" : "warn");
  $("guardLink").href = c.guardAddress ? explorer("address", c.guardAddress) : "#";
  $("poolLink").href = c.poolAddress ? explorer("address", c.poolAddress) : "#";
  if (!c.guardAddress) $("guardLink").textContent = "SurvivalGuard (not deployed yet)";

  const sel = $("fDebtAsset");
  sel.innerHTML = "";
  (S.stables.length ? S.stables : S.reserves).forEach((r) => {
    const o = document.createElement("option");
    o.value = r.address;
    o.textContent = r.symbol;
    sel.appendChild(o);
  });
  if (!sel.options.length) sel.innerHTML = `<option value="">no reserves in config</option>`;
  sel.addEventListener("change", () => {
    $("fMaxRepayHint").textContent = `${symbolOf(sel.value)} units, hard cap per call`;
    refreshPlanState();
  });
  sel.dispatchEvent(new Event("change"));

  if (c.chainId === 1952 && c.poolAddress) setupDemo();
  if (!c.guardAddress)
    msg("SurvivalGuard is not deployed on this network yet — reads work, enroll is disabled.", "warn");
}

// ------------------------------------------------------------------ wallet
function getProvider() {
  return window.okxwallet || window.ethereum || null;
}

async function ensureChain(provider) {
  const hex = "0x" + S.cfg.chainId.toString(16);
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch (e) {
    if (e?.code === 4902 || /unrecognized|not added|4902/i.test(e?.message || "")) {
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: hex,
            chainName: S.cfg.chainName,
            nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
            rpcUrls: [S.cfg.rpcUrl],
            blockExplorerUrls: [S.cfg.explorerBase],
          },
        ],
      });
    } else throw e;
  }
}

async function connect() {
  const provider = getProvider();
  if (!provider) {
    msg("No wallet found. Install OKX Wallet (okx.com/web3) and reload.", "err");
    return;
  }
  try {
    $("connectBtn").disabled = true;
    const [acct] = await provider.request({ method: "eth_requestAccounts" });
    await ensureChain(provider);
    S.provider = provider;
    S.account = acct;
    S.wallet = createWalletClient({ account: acct, chain: S.chain, transport: custom(provider) });
    $("connectBtn").textContent = short(acct);
    $("posAddr").textContent = short(acct);
    $("posAddr").title = acct;
    msg("");
    setEnabled(["refreshBtn", "explainBtn", "tgBtn"], true);
    provider.on?.("accountsChanged", () => location.reload());
    provider.on?.("chainChanged", () => location.reload());
    await refreshAll();
  } catch (e) {
    msg(`Wallet: ${errText(e)}`, "err");
  } finally {
    $("connectBtn").disabled = false;
  }
}

async function sendTx(logId, label, req) {
  const item = log(logId, `<span class="spin"></span> ${esc(label)} — confirm in wallet…`);
  try {
    const hash = await S.wallet.writeContract({ ...req, account: S.account, chain: S.chain });
    item.innerHTML = `<span class="spin"></span> ${esc(label)} — pending ${link("tx", hash)}`;
    const rc = await S.pub.waitForTransactionReceipt({ hash });
    const ok = rc.status === "success";
    item.className = `item ${ok ? "ok" : "err"}`;
    item.innerHTML = `${ok ? "✓" : "✗"} ${esc(label)} — ${ok ? "confirmed" : "reverted"} ${link("tx", hash)}`;
    if (!ok) throw new Error("transaction reverted");
    return hash;
  } catch (e) {
    item.className = "item err";
    item.innerHTML = `✗ ${esc(label)} — ${esc(errText(e))}`;
    throw e;
  }
}

// ------------------------------------------------------------------ position
function normalizePosition(p) {
  const x = p || {};
  const hfRaw = x.hf ?? x.healthFactor;
  const hf = hfRaw === null || hfRaw === "inf" || hfRaw === undefined ? null : Number(hfRaw);
  return {
    hf: hf !== null && hf > 1e6 ? Infinity : hf,
    collateralUsd: x.collateralUsd ?? x.totalCollateralUsd,
    debtUsd: x.debtUsd ?? x.totalDebtUsd,
    ltBps: x.liquidationThresholdBps ?? x.ltBps,
    reserves: (x.reserves || []).map((r) => ({
      symbol: r.symbol,
      address: r.address,
      decimals: r.decimals ?? decimalsOf(r.address),
      price: r.priceUsd ?? r.price,
      supplied: r.supplied ?? r.suppliedTokens ?? r.collateral,
      borrowed: r.borrowed ?? r.borrowedTokens ?? r.debt,
    })),
    plan: x.plan ?? null,
    raw: x,
  };
}

function renderGauge(hf) {
  const g = $("hfGauge");
  g.classList.remove("amber", "red");
  const c = hfColor(hf);
  if (c !== "green") g.classList.add(c);
  const L = 201;
  // map HF 1.0 → 0%, 2.0+ → 100%
  const pct = !has(hf) ? 0 : hf === Infinity ? 1 : Math.max(0, Math.min(1, (hf - 1) / 1));
  $("hfArc").style.strokeDashoffset = String(L - L * pct);
  $("hfText").textContent = has(hf) ? fmtHf(hf) : dash;
}

function liqPriceHint(r, pos) {
  // For a single collateral asset: price at which hf hits 1 = price * (1 / hf). Rough hint per asset.
  const sup = Number(r.supplied),
    price = Number(r.price);
  if (!(sup > 0) || !(price > 0) || !has(pos.hf) || pos.hf === Infinity || !(pos.hf > 0)) return dash;
  const drop = 1 - 1 / pos.hf;
  return `${fmtUsd(price * (1 - drop))} (−${(drop * 100).toFixed(1)}%)`;
}

async function loadPosition() {
  if (!S.account) return;
  $("posStatus").textContent = "Reading position…";
  let pos;
  try {
    pos = normalizePosition(await api(`/api/position/${S.account}`));
  } catch (e) {
    $("posStatus").textContent = `Could not read position from server: ${errText(e)}`;
    pos = normalizePosition({});
  }
  S.position = pos;
  renderGauge(pos.hf);
  $("posCollateral").textContent = fmtUsd(pos.collateralUsd);
  $("posDebt").textContent = fmtUsd(pos.debtUsd);
  $("posLt").textContent = has(pos.ltBps) ? `${(Number(pos.ltBps) / 100).toFixed(2)}%` : dash;
  const rows = pos.reserves.filter((r) => Number(r.supplied) > 0 || Number(r.borrowed) > 0);
  $("reserveRows").innerHTML = rows.length
    ? rows
        .map(
          (r) => `<tr><td>${esc(r.symbol)}</td><td class="num">${fmtUsd(r.price)}</td>
          <td class="num">${fmtNum(r.supplied)}</td><td class="num">${fmtNum(r.borrowed)}</td>
          <td class="num">${Number(r.supplied) > 0 ? liqPriceHint(r, pos) : dash}</td></tr>`,
        )
        .join("")
    : `<tr><td colspan="5" class="mute">no supplied or borrowed assets found</td></tr>`;
  const c = hfColor(pos.hf);
  $("posStatus").innerHTML = !has(pos.hf)
    ? "No debt — nothing to protect yet."
    : `<span class="pill ${c}">${c === "green" ? "healthy" : c === "amber" ? "watch" : "danger"}</span> ` +
      (pos.hf === Infinity ? "No debt." : `HF ${fmtHf(pos.hf)} — liquidation happens below 1.00.`);

  // on-chain sanity read
  try {
    if (S.cfg.poolAddress) {
      const d = await S.pub.readContract({
        address: S.cfg.poolAddress,
        abi: POOL_ABI,
        functionName: "getUserAccountData",
        args: [S.account],
      });
      const hf = wadToNum(d[5]);
      $("posHfChain").textContent = d[1] === 0n ? "∞" : fmtHf(hf);
      if (!has(pos.hf) && d[1] > 0n) renderGauge(hf);
    } else $("posHfChain").textContent = dash;
  } catch {
    $("posHfChain").textContent = dash;
  }
}

// ------------------------------------------------------------------ AI report
function normalizeExplain(r) {
  const x = r || {};
  const ex = x.explain || x;
  const rc = x.recommend || x.recommendation || ex.recommendation || null;
  return {
    summary: ex.summary,
    risks: ex.risks || ex.riskFactors || [],
    riskLevel: ex.riskLevel,
    liquidationPrices: ex.liquidationPrices || [],
    source: ex.source || x.source || x.model || (rc && rc.source) || "",
    reco: rc
      ? {
          debtAsset: rc.debtAsset,
          triggerHF: rc.triggerHF,
          targetHF: rc.targetHF,
          maxRepayPerProtect: rc.maxRepayPerProtect,
          cooldown: rc.cooldown,
          bufferUsd: rc.bufferUsd,
          rationale: Array.isArray(rc.rationale) ? rc.rationale : rc.rationale ? [rc.rationale] : [],
          source: rc.source || "",
        }
      : null,
  };
}

async function explain() {
  if (!S.account) return;
  $("explainBtn").disabled = true;
  $("aiSummary").innerHTML = `<span class="spin"></span> The Sentinel is reading your position…`;
  try {
    const r = normalizeExplain(
      await api("/api/explain", { method: "POST", body: JSON.stringify({ address: S.account }) }),
    );
    $("aiSummary").className = "summary";
    $("aiSummary").textContent = r.summary || "No summary returned.";
    $("aiRisks").innerHTML = (r.risks || [])
      .map((x) => `<li>${esc(typeof x === "string" ? x : x.text || JSON.stringify(x))}</li>`)
      .join("");
    $("aiLiq").innerHTML = (r.liquidationPrices || [])
      .map((l) => {
        const sym = esc(l.symbol || l.asset || "");
        const price = has(l.price) ? fmtUsd(l.price) : has(l.priceUsd) ? fmtUsd(l.priceUsd) : dash;
        const drop = has(l.dropPct) ? ` (−${fmtNum(l.dropPct, 1)}%)` : "";
        return `${sym} liquidates near ${price}${drop}`;
      })
      .join(" · ");
    const src = (r.source || "").toLowerCase();
    const isRules = !src || src === "rules" || src === "fallback";
    $("aiSource").className = `badge ${isRules ? "rules" : "ai"}`;
    $("aiSource").textContent = isRules ? "rules" : "AI";
    $("aiSource").title = r.source || "";
    if (r.reco) {
      S.reco = r.reco;
      const ra = r.reco.debtAsset;
      $("aiRecoKv").innerHTML = [
        ["Debt asset", has(ra) ? (isAddress(String(ra)) ? symbolOf(ra) : ra) : dash],
        ["Trigger HF", has(r.reco.triggerHF) ? fmtNum(r.reco.triggerHF, 2) : dash],
        ["Target HF", has(r.reco.targetHF) ? fmtNum(r.reco.targetHF, 2) : dash],
        ["Max repay / protect", has(r.reco.maxRepayPerProtect) ? fmtNum(r.reco.maxRepayPerProtect, 2) : dash],
        ["Cooldown", has(r.reco.cooldown) ? `${Math.round(Number(r.reco.cooldown) / 60)} min` : dash],
        ["Suggested buffer", has(r.reco.bufferUsd) ? fmtUsd(r.reco.bufferUsd) : dash],
      ]
        .map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`)
        .join("");
      $("aiRationale").innerHTML = r.reco.rationale.map((x) => `<li>${esc(x)}</li>`).join("");
      $("aiReco").classList.remove("hidden");
    }
  } catch (e) {
    $("aiSummary").className = "summary mute";
    $("aiSummary").textContent =
      `The report is unavailable right now (${errText(e)}). You can still set a plan by hand below.`;
  } finally {
    $("explainBtn").disabled = false;
  }
}

function usePlan() {
  const r = S.reco;
  if (!r) return;
  const sel = $("fDebtAsset");
  if (has(r.debtAsset)) {
    const res = reserveOf(r.debtAsset);
    if (res) sel.value = res.address;
  }
  if (has(r.triggerHF)) $("fTrigger").value = Number(r.triggerHF).toFixed(2);
  if (has(r.targetHF)) $("fTarget").value = Number(r.targetHF).toFixed(2);
  if (has(r.maxRepayPerProtect)) $("fMaxRepay").value = String(r.maxRepayPerProtect);
  if (has(r.cooldown)) $("fCooldown").value = String(Math.max(0, Math.round(Number(r.cooldown) / 60)));
  syncApproveDefault();
  sel.dispatchEvent(new Event("change"));
  $("planCard").scrollIntoView({ behavior: "smooth", block: "start" });
}

// ------------------------------------------------------------------ plan form
function readForm() {
  const debtAsset = $("fDebtAsset").value;
  const trigger = Number($("fTrigger").value);
  const target = Number($("fTarget").value);
  const maxRepay = $("fMaxRepay").value;
  const cooldownMin = Number($("fCooldown").value);
  const errs = [];
  if (!isAddress(debtAsset || "")) errs.push("pick a debt asset");
  if (!(trigger >= 1)) errs.push("trigger HF must be ≥ 1.00");
  if (!(target > trigger)) errs.push("target HF must be above trigger");
  if (!(target <= 10)) errs.push("target HF must be ≤ 10");
  if (!(Number(maxRepay) > 0)) errs.push("max repay must be > 0");
  if (!(cooldownMin >= 0) || !Number.isInteger(cooldownMin)) errs.push("cooldown must be whole minutes ≥ 0");
  const el = $("planErr");
  el.classList.toggle("hidden", errs.length === 0);
  el.textContent = errs.join(" · ");
  if (errs.length) return null;
  return {
    debtAsset,
    triggerHF: parseUnits(trigger.toFixed(6), 18),
    targetHF: parseUnits(target.toFixed(6), 18),
    maxRepayPerProtect: parseUnits(String(maxRepay), decimalsOf(debtAsset)),
    cooldown: cooldownMin * 60,
    active: true,
  };
}

function syncApproveDefault() {
  if ($("fUnlimited").checked) return;
  const m = Number($("fMaxRepay").value);
  if (m > 0) $("fApprove").value = String(Number((m * 3).toPrecision(8)));
}

async function refreshPlanState() {
  if (!S.account) return;
  const debtAsset = $("fDebtAsset").value;
  const guard = S.cfg.guardAddress;
  // plan
  try {
    if (!guard) throw new Error("no guard");
    const p = await S.pub.readContract({
      address: guard,
      abi: GUARD_ABI,
      functionName: "plans",
      args: [S.account],
    });
    S.plan = p;
    const exists = p && p.debtAsset && p.debtAsset !== "0x0000000000000000000000000000000000000000";
    $("curPlan").innerHTML = exists
      ? `<span class="pill ${p.active ? "green" : "grey"}">${p.active ? "active" : "disabled"}</span> repay ${esc(symbolOf(p.debtAsset))} when HF &lt; ${fmtHf(wadToNum(p.triggerHF))} → ${fmtHf(wadToNum(p.targetHF))}, max ${fmtUnits(p.maxRepayPerProtect, p.debtAsset, 2)}, cooldown ${Number(p.cooldown) / 60} min`
      : "none";
    $("disableBtn").disabled = !(exists && p.active);
    if (exists && !S.reco) {
      $("fDebtAsset").value = p.debtAsset;
      $("fTrigger").value = fmtHf(wadToNum(p.triggerHF));
      $("fTarget").value = fmtHf(wadToNum(p.targetHF));
      $("fMaxRepay").value = formatUnits(p.maxRepayPerProtect, decimalsOf(p.debtAsset));
      $("fCooldown").value = String(Math.round(Number(p.cooldown) / 60));
      syncApproveDefault();
    }
  } catch {
    S.plan = null;
    $("curPlan").textContent = guard ? dash : "guard not deployed";
    $("disableBtn").disabled = true;
  }
  // allowance + balance for the selected asset
  try {
    if (!isAddress(debtAsset || "")) throw new Error("no asset");
    const [al, bal] = await Promise.all([
      guard
        ? S.pub.readContract({
            address: debtAsset,
            abi: ERC20_ABI,
            functionName: "allowance",
            args: [S.account, guard],
          })
        : Promise.resolve(null),
      S.pub.readContract({
        address: debtAsset,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [S.account],
      }),
    ]);
    $("curAllowance").textContent =
      al === null ? dash : al >= UINT_MAX / 2n ? "unlimited" : fmtUnits(al, debtAsset, 2);
    $("curBalance").textContent = fmtUnits(bal, debtAsset, 2);
    $("revokeBtn").disabled = !(guard && al && al > 0n);
  } catch {
    $("curAllowance").textContent = dash;
    $("curBalance").textContent = dash;
    $("revokeBtn").disabled = true;
  }
  const canWrite = Boolean(S.wallet && guard);
  setEnabled(["approveBtn", "enrollBtn"], canWrite);
}

// ------------------------------------------------------------------ tx actions
async function approve(revoke = false) {
  const debtAsset = $("fDebtAsset").value;
  if (!isAddress(debtAsset || "")) return msg("Pick a debt asset first.", "warn");
  let amount = 0n;
  if (!revoke) {
    amount = $("fUnlimited").checked
      ? UINT_MAX
      : parseUnits(String($("fApprove").value || "0"), decimalsOf(debtAsset));
    if (amount <= 0n) return msg("Approve amount must be > 0.", "warn");
  }
  try {
    await sendTx(
      "txLog",
      revoke
        ? `Revoke ${symbolOf(debtAsset)} allowance`
        : `Approve ${amount === UINT_MAX ? "unlimited" : formatUnits(amount, decimalsOf(debtAsset))} ${symbolOf(debtAsset)}`,
      { address: debtAsset, abi: ERC20_ABI, functionName: "approve", args: [S.cfg.guardAddress, amount] },
    );
    await refreshPlanState();
  } catch {
    /* logged */
  }
}

async function enroll() {
  const plan = readForm();
  if (!plan) return;
  try {
    await sendTx("txLog", `Enroll plan (${symbolOf(plan.debtAsset)}, trigger ${$("fTrigger").value})`, {
      address: S.cfg.guardAddress,
      abi: GUARD_ABI,
      functionName: "enroll",
      args: [plan],
    });
    S.reco = null;
    await refreshAll();
  } catch {
    /* logged */
  }
}

async function disablePlan() {
  try {
    await sendTx("txLog", "Disable protection", {
      address: S.cfg.guardAddress,
      abi: GUARD_ABI,
      functionName: "disable",
      args: [],
    });
    await refreshAll();
  } catch {
    /* logged */
  }
}

// ------------------------------------------------------------------ dashboard
function sparkline(snaps, trigger) {
  const svg = $("spark");
  const pts = (snaps || [])
    .map((s) => ({ t: Number(s.ts ?? s.timestamp ?? s.t), hf: Number(s.hf ?? s.healthFactor) }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.hf))
    .map((p) => ({ ...p, hf: Math.min(p.hf, 5) }))
    .sort((a, b) => a.t - b.t);
  if (pts.length < 2) {
    svg.innerHTML = `<text x="6" y="50">${pts.length ? "one snapshot so far — the sentinel adds one every minute" : "no snapshots yet"}</text>`;
    return;
  }
  const W = Math.max(320, Math.round(svg.clientWidth || 600)),
    H = 90,
    pad = 6;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const t0 = pts[0].t,
    t1 = pts[pts.length - 1].t || t0 + 1;
  const hfs = pts.map((p) => p.hf).concat(trigger ? [trigger] : [], [1]);
  const lo = Math.max(0, Math.min(...hfs) - 0.1),
    hi = Math.max(...hfs) + 0.1;
  const x = (t) => pad + ((t - t0) / Math.max(1, t1 - t0)) * (W - 2 * pad);
  const y = (v) => H - pad - ((v - lo) / (hi - lo)) * (H - 2 * pad);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)} ${y(p.hf).toFixed(1)}`).join(" ");
  const area = `${d} L${x(t1).toFixed(1)} ${H - pad} L${x(t0).toFixed(1)} ${H - pad} Z`;
  const last = pts[pts.length - 1];
  svg.innerHTML =
    `<path class="area" d="${area}"/><path class="line" d="${d}"/>` +
    (trigger
      ? `<line class="trig" x1="0" x2="${W}" y1="${y(trigger).toFixed(1)}" y2="${y(trigger).toFixed(1)}"/><text x="${W - 80}" y="${(y(trigger) - 3).toFixed(1)}">trigger ${trigger.toFixed(2)}</text>`
      : "") +
    (lo < 1
      ? `<line class="liq" x1="0" x2="${W}" y1="${y(1).toFixed(1)}" y2="${y(1).toFixed(1)}"/><text x="4" y="${(y(1) - 3).toFixed(1)}">liq 1.00</text>`
      : "") +
    `<text x="${Math.min(W - 60, x(last.t) + 4).toFixed(1)}" y="${Math.max(12, y(last.hf) - 4).toFixed(1)}">${last.hf.toFixed(2)}</text>`;
}

async function loadDashboard() {
  if (!S.account) return;
  // previewProtect on chain
  try {
    if (!S.cfg.guardAddress) throw new Error("no guard");
    const [eligible, reason, , repay] = await S.pub.readContract({
      address: S.cfg.guardAddress,
      abi: GUARD_ABI,
      functionName: "previewProtect",
      args: [S.account],
    });
    $("pvEligible").innerHTML =
      `<span class="pill ${eligible ? "red" : "green"}">${eligible ? "yes — eligible" : "no"}</span>`;
    $("pvReason").textContent = reason || (eligible ? "HF below trigger" : "nothing to do");
    const asset = S.plan?.debtAsset;
    $("pvRepay").textContent = repay && repay > 0n ? fmtUnits(repay, asset, 2) : dash;
  } catch {
    $("pvEligible").textContent = dash;
    $("pvReason").textContent = S.cfg.guardAddress ? "previewProtect unavailable" : "guard not deployed";
    $("pvRepay").textContent = dash;
  }
  // history
  try {
    const h = await api(`/api/history/${S.account}`);
    const prots = h.protections || [];
    $("histCount").textContent = String(prots.length);
    $("histLast").textContent = prots.length ? fmtTs(prots[0].ts ?? prots[0].timestamp) : dash;
    const trig = S.plan?.active ? wadToNum(S.plan.triggerHF) : null;
    sparkline(h.snapshots || [], trig && Number.isFinite(trig) ? trig : null);
    $("protRows").innerHTML = prots.length
      ? prots
          .slice(0, 20)
          .map((p) => {
            const asset = p.debtAsset || S.plan?.debtAsset;
            const repaid = has(p.repaid)
              ? /^\d+$/.test(String(p.repaid)) && asset
                ? fmtUnits(p.repaid, asset, 2)
                : `${fmtNum(p.repaid, 2)} ${esc(p.symbol || symbolOf(asset))}`
              : dash;
            return `<tr><td>${fmtTs(p.ts ?? p.timestamp)}</td><td class="num">${repaid}</td>
            <td class="num">${fmtHf(p.hfBefore)} → ${fmtHf(p.hfAfter)}</td><td>${p.txHash ? link("tx", p.txHash) : dash}</td></tr>`;
          })
          .join("")
      : `<tr><td colspan="4" class="mute">no protections yet</td></tr>`;
  } catch (e) {
    $("histCount").textContent = dash;
    sparkline([], null);
    $("protRows").innerHTML =
      `<tr><td colspan="4" class="mute">history unavailable (${esc(errText(e))})</td></tr>`;
  }
}

async function telegramLink() {
  if (!S.account) return;
  $("tgBtn").disabled = true;
  const box = $("tgBox");
  try {
    const r = await api("/api/telegram/link", {
      method: "POST",
      body: JSON.stringify({ address: S.account }),
    });
    const deep =
      r.deepLink ||
      (r.token && S.cfg.telegramBotUsername
        ? `https://t.me/${S.cfg.telegramBotUsername}?start=${r.token}`
        : "");
    box.classList.remove("hidden");
    box.innerHTML = deep
      ? `Open <a href="${esc(deep)}" target="_blank" rel="noopener">${esc(deep)}</a> in Telegram and press <strong>Start</strong>. The bot binds this chat to ${short(S.account)} and will message you on enroll, warning, protection and failure.`
      : `Telegram bot is not configured on this server yet.${r.token ? ` Your bind token: <code>${esc(r.token)}</code>` : ""}`;
  } catch (e) {
    box.classList.remove("hidden");
    box.className = "alert warn";
    box.textContent = `Telegram link unavailable: ${errText(e)}`;
  } finally {
    $("tgBtn").disabled = false;
  }
}

// ------------------------------------------------------------------ demo lab (testnet MockPool)
function setupDemo() {
  $("demoCard").classList.remove("hidden");
  const col = $("dCollateral"),
    debt = $("dDebt");
  S.reserves.forEach((r) => {
    const o = document.createElement("option");
    o.value = r.address;
    o.textContent = r.symbol;
    (r.isStable ? debt : col).appendChild(o);
  });
  if (!col.options.length) col.innerHTML = `<option value="">no volatile reserve</option>`;
  if (!debt.options.length) debt.innerHTML = `<option value="">no stable reserve</option>`;
  const demoIds = ["dMintCol", "dMintDebt", "dSupply", "dBorrow"];
  const enable = () => setEnabled(demoIds, Boolean(S.wallet));
  enable();
  document.addEventListener("ls:connected", enable);

  const mint = async (asset, amtStr) => {
    const amt = parseUnits(String(amtStr || "0"), decimalsOf(asset));
    await sendTx("demoLog", `Mint ${amtStr} ${symbolOf(asset)}`, {
      address: asset,
      abi: ERC20_ABI,
      functionName: "mint",
      args: [S.account, amt],
    });
  };
  $("dMintCol").onclick = () =>
    mint(col.value, $("dSupplyAmt").value)
      .then(refreshAll)
      .catch(() => {});
  $("dMintDebt").onclick = () =>
    mint(debt.value, $("dBorrowAmt").value)
      .then(refreshAll)
      .catch(() => {});
  $("dSupply").onclick = async () => {
    const asset = col.value,
      amt = parseUnits(String($("dSupplyAmt").value || "0"), decimalsOf(asset));
    try {
      const al = await S.pub.readContract({
        address: asset,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [S.account, S.cfg.poolAddress],
      });
      if (al < amt)
        await sendTx("demoLog", `Approve ${symbolOf(asset)} to MockPool`, {
          address: asset,
          abi: ERC20_ABI,
          functionName: "approve",
          args: [S.cfg.poolAddress, amt],
        });
      await sendTx("demoLog", `Supply ${$("dSupplyAmt").value} ${symbolOf(asset)}`, {
        address: S.cfg.poolAddress,
        abi: POOL_ABI,
        functionName: "supply",
        args: [asset, amt, S.account, 0],
      });
      await refreshAll();
    } catch {
      /* logged */
    }
  };
  $("dBorrow").onclick = async () => {
    const asset = debt.value,
      amt = parseUnits(String($("dBorrowAmt").value || "0"), decimalsOf(asset));
    try {
      await sendTx("demoLog", `Borrow ${$("dBorrowAmt").value} ${symbolOf(asset)}`, {
        address: S.cfg.poolAddress,
        abi: POOL_ABI,
        functionName: "borrow",
        args: [asset, amt, 2n, 0, S.account],
      });
      await refreshAll();
    } catch {
      /* logged */
    }
  };
}

// ------------------------------------------------------------------ orchestration
async function refreshAll() {
  if (!S.account) return;
  $("refreshBtn").disabled = true;
  try {
    await loadPosition();
    await refreshPlanState();
    await loadDashboard();
    document.dispatchEvent(new Event("ls:connected"));
  } finally {
    $("refreshBtn").disabled = false;
  }
}

function wire() {
  $("connectBtn").addEventListener("click", connect);
  $("refreshBtn").addEventListener("click", refreshAll);
  $("explainBtn").addEventListener("click", explain);
  $("usePlanBtn").addEventListener("click", usePlan);
  $("approveBtn").addEventListener("click", () => approve(false));
  $("revokeBtn").addEventListener("click", () => approve(true));
  $("enrollBtn").addEventListener("click", enroll);
  $("disableBtn").addEventListener("click", disablePlan);
  $("tgBtn").addEventListener("click", telegramLink);
  $("fMaxRepay").addEventListener("input", syncApproveDefault);
  $("fUnlimited").addEventListener("change", () => {
    $("fApprove").disabled = $("fUnlimited").checked;
    syncApproveDefault();
  });
  ["fTrigger", "fTarget", "fMaxRepay", "fCooldown"].forEach((id) =>
    $(id).addEventListener("input", readForm),
  );
  // auto-explain once a position is loaded the first time
  document.addEventListener("ls:connected", () => {
    if (!S.reco && !$("explainBtn").dataset.ran) {
      $("explainBtn").dataset.ran = "1";
      explain();
    }
  });
}

(async function main() {
  wire();
  await loadConfig();
  // silently reconnect if the wallet already granted access
  const p = getProvider();
  if (p?.request) {
    try {
      const accts = await p.request({ method: "eth_accounts" });
      if (accts && accts[0]) await connect();
    } catch {
      /* ignore */
    }
  }
})();
