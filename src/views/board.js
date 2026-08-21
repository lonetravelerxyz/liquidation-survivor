// Survival Board — public stats page. Vanilla JS, no wallet needed.
const $ = (id) => document.getElementById(id);
const dash = "—";
const has = (v) => v !== undefined && v !== null && v !== "";
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
const short = (a) => (a ? (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a) : dash);
const fmtNum = (v, d = 2) => {
  const n = Number(v);
  return has(v) && Number.isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: d }) : dash;
};
const fmtUsd = (v) => {
  const n = Number(v);
  return has(v) && Number.isFinite(n)
    ? n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 })
    : dash;
};
const fmtHf = (v) => {
  const n = Number(v);
  return has(v) && Number.isFinite(n) ? (n > 1e6 ? "∞" : n.toFixed(2)) : dash;
};
const fmtTs = (ts) => {
  if (!has(ts)) return dash;
  const n = Number(ts);
  const d = new Date(n < 1e12 ? n * 1000 : n);
  return Number.isNaN(d.getTime()) ? String(ts) : d.toLocaleString();
};

let explorerBase = "";
const link = (kind, v, text) =>
  explorerBase && v && !/…|\.\.\./.test(String(v))
    ? `<a href="${explorerBase}/${kind}/${v}" target="_blank" rel="noopener" class="mono">${esc(text || short(v))}</a>`
    : `<span class="mono">${esc(text || short(v))}</span>`;

async function loadConfig() {
  try {
    const c = await (await fetch("/api/config")).json();
    const chainId = Number(c.chainId ?? (c.chain === "mainnet" ? 196 : 1952));
    explorerBase =
      c.explorerBase ||
      (chainId === 196
        ? "https://web3.okx.com/explorer/x-layer"
        : "https://web3.okx.com/explorer/x-layer-testnet");
    $("netName").textContent = `${chainId === 196 ? "X Layer" : "X Layer Testnet"} · ${chainId}`;
    $("netBadge").classList.add(chainId === 196 ? "ok" : "warn");
    const guard = c.guardAddress || c.guard;
    if (guard) $("guardLink").href = `${explorerBase}/address/${guard}`;
  } catch {
    $("netName").textContent = "network unknown";
  }
}

async function loadBoard() {
  let b;
  try {
    const r = await fetch("/api/board");
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    b = await r.json();
    $("boardMsg").classList.add("hidden");
  } catch (e) {
    $("boardMsg").classList.remove("hidden");
    $("boardMsg").textContent = `stats unavailable (${e.message})`;
    return;
  }
  $("sEnrolled").textContent = fmtNum(b.enrolled ?? b.protectedWallets ?? b.activePlans, 0);
  $("sProtections").textContent = fmtNum(
    b.protections ?? b.protectionsExecuted ?? (Array.isArray(b.recent) ? b.recent.length : null),
    0,
  );
  $("sRepaid").textContent = has(b.repaidUsd) ? fmtUsd(b.repaidUsd) : dash;
  const byAsset = b.repaidByAsset || b.totalRepaid || null;
  $("sRepaidByAsset").textContent = byAsset
    ? Array.isArray(byAsset)
      ? byAsset.map((x) => `${fmtNum(x.amount ?? x.repaid)} ${x.symbol || ""}`).join(" · ")
      : Object.entries(byAsset)
          .map(([k, v]) => `${fmtNum(v)} ${k}`)
          .join(" · ")
    : "";
  $("sBlock").textContent = has(b.lastIndexedBlock ?? b.lastBlock)
    ? fmtNum(b.lastIndexedBlock ?? b.lastBlock, 0)
    : dash;
  $("sUpdated").textContent = `updated ${new Date().toLocaleTimeString()}`;

  const recent = b.recent || b.recentProtections || b.protectionsList || [];
  $("rows").innerHTML = recent.length
    ? recent
        .slice(0, 50)
        .map(
          (
            p,
          ) => `<tr><td>${fmtTs(p.ts ?? p.timestamp)}</td><td>${link("address", p.addressFull ?? p.address ?? p.user, p.user ?? p.address)}</td>
          <td class="num">${has(p.repaid) ? `${fmtNum(p.repaid, 4)} ${esc(p.symbol || p.asset || "")}` : dash}</td>
          <td class="num">${fmtHf(p.hfBefore)} → ${fmtHf(p.hfAfter)}</td><td>${link("address", p.keeper)}</td>
          <td>${p.txHash ? link("tx", p.txHash) : dash}</td></tr>`,
        )
        .join("")
    : `<tr><td colspan="6" class="mute">no protections yet — the sentinel is watching</td></tr>`;

  const wallets = b.addresses || b.wallets || [];
  $("walletRows").innerHTML = wallets.length
    ? wallets
        .slice(0, 50)
        .map(
          (w) =>
            `<tr><td>${link("address", w.addressFull ?? w.address, w.address)}</td><td class="num">${fmtNum(w.protections, 0)}</td><td class="num">${fmtHf(w.lastHf)}</td></tr>`,
        )
        .join("")
    : `<tr><td colspan="3" class="mute">no enrolled wallets yet</td></tr>`;
}

$("shareLink").addEventListener("click", async (e) => {
  e.preventDefault();
  const url = `${location.origin}/`;
  try {
    await navigator.clipboard.writeText(url);
    $("shareLink").textContent = "Link copied";
  } catch {
    prompt("Share this link", url);
  }
});

(async () => {
  await loadConfig();
  await loadBoard();
  setInterval(loadBoard, 30_000);
})();
