import { useState, useMemo } from "react";
import { connectWallet, buyAndShoot, shoot, settleRound, listenAccountChanges } from "../lib/wallet";
import { fmtAddr, explorerUrl, fmtBnb } from "../lib/api";

/**
 * PlayPanel — 用户在前端直接连接钱包并参与游戏（无需跳转 Flap.sh）
 *
 * 两种入口：
 *  ⚽ buyAndShoot: 一键买代币 + 自动射门
 *  🎯 shoot:     已有代币时直接射门
 */
export default function PlayPanel({ state }) {
  const [wallet, setWallet] = useState(null);
  const [bnbAmount, setBnbAmount] = useState("0.005");
  const [mode, setMode] = useState("buyAndShoot"); // buyAndShoot | shoot
  const [status, setStatus] = useState("");
  const [txHash, setTxHash] = useState("");
  const [loading, setLoading] = useState(false);

  const connect = async () => {
    setStatus("");
    try {
      const w = await connectWallet(state?.chain_id || 56);
      setWallet(w);
      listenAccountChanges(
        () => window.location.reload(),
        () => window.location.reload()
      );
    } catch (e) {
      setStatus(`✕ ${e.message || "连接失败"}`);
    }
  };

  const disconnect = () => {
    setWallet(null);
    setStatus("");
    setTxHash("");
  };

  const handlePlay = async () => {
    if (!wallet) return connect();
    if (!state?.vault_address) {
      setStatus("✕ 金库未配置 / Vault not configured");
      return;
    }
    setLoading(true); setStatus(""); setTxHash("");
    try {
      let tx;
      if (mode === "buyAndShoot") {
        if (!bnbAmount || parseFloat(bnbAmount) <= 0) {
          throw new Error("请输入有效的 BNB 数量");
        }
        setStatus("📤 发送交易中…请在钱包确认");
        tx = await buyAndShoot({
          signer: wallet.signer,
          vaultAddress: state.vault_address,
          bnbAmount,
        });
      } else {
        setStatus("📤 发送 shoot 交易中…请在钱包确认");
        tx = await shoot({
          signer: wallet.signer,
          vaultAddress: state.vault_address,
          playerAddress: wallet.address,
        });
      }
      setTxHash(tx.hash);
      setStatus("⏳ 等待区块确认 / Waiting for confirmation…");
      await tx.wait();
      setStatus("✅ 射门成功！倒计时已重置 / Goal! Timer reset.");
    } catch (e) {
      const msg = e?.shortMessage || e?.reason || e?.message || "交易失败";
      setStatus(`✕ ${msg.slice(0, 200)}`);
    } finally { setLoading(false); }
  };

  const handleSettle = async () => {
    if (!wallet) return connect();
    setLoading(true); setStatus(""); setTxHash("");
    try {
      setStatus("📤 触发结算 settleRound…");
      const tx = await settleRound({ signer: wallet.signer, vaultAddress: state.vault_address });
      setTxHash(tx.hash);
      await tx.wait();
      setStatus("✅ 结算成功！上一轮赢家已领奖 / Settled!");
    } catch (e) {
      const msg = e?.shortMessage || e?.reason || e?.message || "结算失败";
      setStatus(`✕ ${msg.slice(0, 200)}`);
    } finally { setLoading(false); }
  };

  const canSettle = state?.time_remaining_seconds === 0
    && state?.deadline_unix > 0
    && state?.last_shooter && state.last_shooter !== "0x0000000000000000000000000000000000000000";

  // 根据合约 minShotValue 计算建议买入 BNB：假定有效到金库率 ~0.8%（1% 税 × ~80% 入池），留 30% 安全边界
  const suggested = useMemo(() => {
    try {
      const min = BigInt(state?.min_shot_value_wei || "0");
      if (min === 0n) return null;
      // 建议 = min / 0.008 × 1.3 ≈ min * 1300 / 8
      const rec = (min * 1300n) / 8n;
      const recBnb = Number(rec) / 1e18;
      const minBnb = Number(min) / 1e18;
      return { rec: recBnb.toFixed(3), threshold: minBnb.toFixed(4) };
    } catch { return null; }
  }, [state?.min_shot_value_wei]);

  // 检查当前钱包是否在 recent_low_tax_buys 中（用于针对性提示）
  const myLowTaxBuy = useMemo(() => {
    if (!wallet || !state?.recent_low_tax_buys?.length) return null;
    const me = wallet.address.toLowerCase();
    return state.recent_low_tax_buys.find((b) => b.buyer?.toLowerCase() === me) || null;
  }, [wallet, state?.recent_low_tax_buys]);

  return (
    <div className="panel-bright p-6" data-testid="play-panel">
      <div className="flex items-center mb-4">
        <div className="font-display text-2xl text-white">🎮 立即参与 / PLAY NOW</div>
        <div className="flex-1"></div>
        {wallet ? (
          <button onClick={disconnect} className="btn-ghost px-3 py-1.5 text-xs" data-testid="disconnect-wallet-btn">
            {fmtAddr(wallet.address)} · 断开
          </button>
        ) : (
          <button onClick={connect} className="btn-primary px-4 py-1.5 text-xs" data-testid="connect-wallet-btn">
            🔌 连接钱包 / Connect Wallet
          </button>
        )}
      </div>

      {/* 模式切换 */}
      <div className="flex gap-2 mb-4">
        <button
          onClick={() => setMode("buyAndShoot")}
          className={`flex-1 px-3 py-2 text-sm ${mode === "buyAndShoot" ? "btn-primary" : "btn-ghost"}`}
          data-testid="mode-buyandshoot"
        >
          ⚽ 一键买币+射门
        </button>
        <button
          onClick={() => setMode("shoot")}
          className={`flex-1 px-3 py-2 text-sm ${mode === "shoot" ? "btn-primary" : "btn-ghost"}`}
          data-testid="mode-shoot"
        >
          🎯 已持币·直接射门
        </button>
      </div>

      {mode === "buyAndShoot" ? (
        <div>
          <div className="text-muted text-xs uppercase mb-1">投入 BNB / BNB to spend</div>
          <div className="flex gap-2">
            <input
              type="number"
              step="0.001"
              value={bnbAmount}
              onChange={(e) => setBnbAmount(e.target.value)}
              placeholder="0.005"
              data-testid="bnb-amount-input"
              style={{ backgroundColor: "#1B241B", color: "#FFFFFF" }}
            />
            <button
              onClick={handlePlay}
              disabled={loading || !state?.configured}
              className="btn-primary px-6 py-2.5 whitespace-nowrap"
              data-testid="play-btn"
            >
              {loading ? "⏳" : (wallet ? "⚽ SHOOT!" : "🔌 连接后开炮")}
            </button>
          </div>
          <div className="text-muted text-xs mt-2 leading-relaxed">
            金库会代您在 Flap 内盘买入 taxToken，代币到您钱包后自动射门重置倒计时。
            <br/>
            <span className="text-accent">
              💡 推荐单笔 ≥ {suggested?.rec || "0.1"} BNB（合约门槛 minShotValue = {suggested?.threshold || "0.001"} BNB）
            </span>
            <br/>
            <span className="text-muted">
              小于该金额时，FLAP 1% 税收稀释后到达金库的 BNB 可能不达门槛，bot 会忽略您的射门。
            </span>
          </div>
          {myLowTaxBuy && (
            <div className="mt-3 p-3 border-l-4 border-accent bg-bg text-xs" data-testid="my-low-tax-warning">
              <div className="text-accent font-bold mb-1">⚠ 您最近的买入未达到射门门槛</div>
              <div className="text-muted">
                tx: <a href={explorerUrl(state?.chain_id, "tx", myLowTaxBuy.tx_hash)} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                  {myLowTaxBuy.tx_hash.slice(0, 14)}…
                </a>
                <br/>
                到达金库 {fmtBnb(myLowTaxBuy.delta_wei, 6)} BNB &lt; 门槛 {fmtBnb(myLowTaxBuy.min_shot_wei, 6)} BNB。
                请加大单笔金额（推荐 ≥ {suggested?.rec || "0.1"} BNB）。
              </div>
            </div>
          )}
        </div>
      ) : (
        <div>
          <div className="text-muted text-xs mb-2 leading-relaxed">
            如果您已经在 Flap 买过 taxToken，且 vault 池子里有足够新增 BNB（≥ minShotValue），可直接射门 — 不花一分钱本金，仅 gas。
          </div>
          <button
            onClick={handlePlay}
            disabled={loading || !state?.configured}
            className="btn-primary px-6 py-3 w-full"
            data-testid="shoot-only-btn"
          >
            {loading ? "⏳ 处理中…" : (wallet ? "🎯 立即射门 / SHOOT!" : "🔌 连接钱包后开炮")}
          </button>
        </div>
      )}

      {/* 结算按钮（倒计时归零时显示） */}
      {canSettle && (
        <div className="mt-4 pt-4 border-t border-border-bright">
          <div className="text-accent font-display text-sm mb-2">⏰ 倒计时归零！</div>
          <button onClick={handleSettle} disabled={loading} className="btn-danger px-6 py-2.5 w-full" data-testid="settle-btn">
            🏆 触发结算 / Settle Round
          </button>
          <div className="text-muted text-xs mt-1">
            最后射门者 {fmtAddr(state.last_shooter)} 将获得奖池 80%
          </div>
        </div>
      )}

      {/* 状态/Tx 显示 */}
      {(status || txHash) && (
        <div className="mt-4 p-3 bg-bg border border-border-bright text-xs font-mono break-all" data-testid="play-status">
          {status && <div className={status.startsWith("✕") ? "text-danger" : status.startsWith("✅") ? "text-primary" : "text-white"}>{status}</div>}
          {txHash && (
            <div className="mt-1">
              tx: <a href={explorerUrl(state?.chain_id, "tx", txHash)} target="_blank" rel="noreferrer" className="text-primary hover:underline">{txHash.slice(0, 18)}…{txHash.slice(-8)} ↗</a>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
