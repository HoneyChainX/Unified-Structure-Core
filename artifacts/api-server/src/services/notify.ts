import { logger } from "../lib/logger";

const BASE = "https://api.telegram.org";

function isConfigured(): boolean {
  return !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

async function send(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  try {
    const res = await fetch(`${BASE}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    });
    if (!res.ok) {
      const body = await res.text();
      logger.warn({ status: res.status, body }, "Telegram notify: request failed");
    }
  } catch (err) {
    logger.warn({ err }, "Telegram notify: send error");
  }
}

export function notifyTradeOpened(params: {
  symbol: string;
  side: "buy" | "sell";
  entryPrice: number | null | undefined;
  positionSizeUsdt: number | null | undefined;
  slPrice: number | null | undefined;
  tp1Price: number | null | undefined;
  paperMode: boolean;
}): void {
  if (!isConfigured()) return;
  const { symbol, side, entryPrice, positionSizeUsdt, slPrice, tp1Price, paperMode } = params;
  const dir = side === "buy" ? "LONG 🟢" : "SHORT 🔴";
  const mode = paperMode ? "[PAPER] " : "[LIVE] ";
  const lines = [
    `<b>${mode}Trade Opened — ${dir} ${symbol}</b>`,
    `Entry: <code>${entryPrice?.toFixed(4) ?? "—"}</code>`,
    `Size: <code>${positionSizeUsdt?.toFixed(2) ?? "—"} USDT</code>`,
    `SL: <code>${slPrice?.toFixed(4) ?? "—"}</code>`,
    `TP1: <code>${tp1Price?.toFixed(4) ?? "—"}</code>`,
  ];
  send(lines.join("\n")).catch(() => {});
}

export function notifyTradeClosed(params: {
  symbol: string;
  side: "buy" | "sell";
  entryPrice: number | null | undefined;
  closePrice: number | null | undefined;
  pnl: number | null | undefined;
  closeReason: string | null | undefined;
  paperMode: boolean;
  positionSizeUsdt: number | null | undefined;
}): void {
  if (!isConfigured()) return;
  const { symbol, side, entryPrice, closePrice, pnl, closeReason, paperMode, positionSizeUsdt } = params;
  const mode = paperMode ? "[PAPER] " : "[LIVE] ";
  const pnlSign = (pnl ?? 0) >= 0 ? "✅ +" : "❌ ";
  const pnlPct = entryPrice && positionSizeUsdt ? ((pnl ?? 0) / positionSizeUsdt * 100).toFixed(2) : null;
  const via = closeReason ? closeReason.toUpperCase() : "MANUAL";
  const lines = [
    `<b>${mode}Trade Closed via ${via} — ${symbol}</b>`,
    `Side: <code>${side.toUpperCase()}</code>  Entry: <code>${entryPrice?.toFixed(4) ?? "—"}</code>  Close: <code>${closePrice?.toFixed(4) ?? "—"}</code>`,
    `P&amp;L: <b>${pnlSign}${(pnl ?? 0).toFixed(4)} USDT${pnlPct != null ? ` (${pnlSign}${pnlPct}%)` : ""}</b>`,
  ];
  send(lines.join("\n")).catch(() => {});
}
