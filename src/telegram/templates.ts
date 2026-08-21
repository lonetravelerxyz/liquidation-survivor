import { config } from "../config.js";
import { explorerAddress, explorerTx } from "../chains/xlayer.js";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const addrLink = (a: string) => `<a href="${explorerAddress(config.chainId, a)}">${short(a)}</a>`;
const hfText = (hf: number | null) => (hf === null || !Number.isFinite(hf) ? "∞ (no debt)" : hf.toFixed(3));

export const templates = {
  linked: (address: string) =>
    `✅ Linked ${addrLink(address)}.\nYou will get a note when your health factor nears the trigger and whenever the guard repays for you.\n/status shows the current state. /unlink removes this chat.`,

  warning: (p: { address: string; hf: number; triggerHf: number; digest?: string }) =>
    `⚠️ <b>Health factor ${hfText(p.hf)}</b> for ${addrLink(p.address)} — trigger is ${p.triggerHf.toFixed(2)}.\n${esc(
      p.digest ??
        "If it crosses, the guard repays from your approved buffer. Adding collateral or buffer now gives more room.",
    )}`,

  protected: (p: {
    address: string;
    txHash: string;
    repaid: string;
    symbol: string;
    hfBefore: number;
    hfAfter: number;
    digest?: string;
  }) =>
    `🛡️ <b>Protected</b> ${addrLink(p.address)}\nRepaid ${esc(p.repaid)} ${esc(p.symbol)} · HF ${hfText(p.hfBefore)} → ${hfText(
      p.hfAfter,
    )}\n${esc(p.digest ?? "The guard repaid part of your debt from your buffer.")}\n<a href="${explorerTx(config.chainId, p.txHash)}">View transaction</a>`,

  failed: (p: { address: string; reason: string }) =>
    `❗ Protect attempt for ${addrLink(p.address)} did not go through: ${esc(p.reason)}. It will retry on the next check.`,

  status: (
    rows: { address: string; hf: number | null; planActive: boolean | null; triggerHf: number | null }[],
  ) =>
    rows.length === 0
      ? "No wallet linked to this chat yet. Open the app, press “Link Telegram” and follow the link."
      : rows
          .map(
            (r) =>
              `${addrLink(r.address)} — HF ${hfText(r.hf)}${
                r.planActive === null
                  ? ""
                  : r.planActive
                    ? ` · guard active (trigger ${r.triggerHf?.toFixed(2)})`
                    : " · guard disabled"
              }`,
          )
          .join("\n"),

  help: () =>
    "Liquidation Survivor bot.\n/start &lt;token&gt; — link a wallet (use the button in the app)\n/status — linked wallets and health factors\n/unlink — remove all wallets from this chat",
};
