import { useEffect, useState, useRef } from "react";
import { api, fmtBnb, fmtAddr, fmtTimer, fmtRelativeTime, openWebSocket, explorerUrl } from "../lib/api";

export default function Dashboard() {
  const [state, setState] = useState(null);
  const [rounds, setRounds] = useState([]);
  const [shots, setShots] = useState([]);
  const [localTimer, setLocalTimer] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const wsRef = useRef(null);
  const localTimerStarted = useRef(0);
  const localDeadline = useRef(0);

  useEffect(() => {
    const load = async () => {
      try {
        const [s, r, sh] = await Promise.all([
          api.get("/game/state"),
          api.get("/game/rounds?limit=10"),
          api.get("/game/shots?limit=30"),
        ]);
        setState(s.data);
        setRounds(r.data);
        setShots(sh.data);
        if (s.data.deadline_unix > 0) {
          localDeadline.current = s.data.deadline_unix;
        }
        setLoaded(true);
      } catch (e) {
        setLoaded(true);
      }
    };
    load();
    const poll = setInterval(load, 8000);

    wsRef.current = openWebSocket((msg) => {
      if (msg.type === "state") {
        setState(msg.data);
        if (msg.data.deadline_unix > 0) localDeadline.current = msg.data.deadline_unix;
      } else if (msg.type === "shot") {
        setShots((prev) => [msg.data, ...prev].slice(0, 30));
      } else if (msg.type === "goal") {
        setRounds((prev) => [msg.data, ...prev].slice(0, 10));
      }
    });

    return () => { clearInterval(poll); if (wsRef.current) wsRef.current.close(); };
  }, []);

  // local countdown ticker
  useEffect(() => {
    const id = setInterval(() => {
      if (localDeadline.current > 0) {
        const now = Math.floor(Date.now() / 1000);
        setLocalTimer(Math.max(0, localDeadline.current - now));
      } else {
        setLocalTimer(0);
      }
    }, 200);
    return () => clearInterval(id);
  }, []);

  const isDanger = localTimer > 0 && localTimer < 60;
  const isLive = state?.bot_running && state?.last_shooter && state?.last_shooter !== "0x0000000000000000000000000000000000000000";

  return (
    <div className="min-h-screen stadium-bg" data-testid="public-dashboard">
      <div className="field-lines min-h-screen">
        <Header state={state} />

        {!state?.configured && (
          <div className="max-w-7xl mx-auto px-4 py-6">
            <div className="panel-bright p-8 text-center" data-testid="not-configured-banner">
              <div className="text-accent font-display text-3xl mb-2">⚙ SETUP REQUIRED</div>
              <div className="text-muted">
                金库尚未配置。请管理员前往 <a href="/admin" className="text-primary underline">/admin</a> 完成设置。
              </div>
            </div>
          </div>
        )}

        {state?.configured && state?.rpc_ok === false && (
          <div className="max-w-7xl mx-auto px-4 py-6">
            <div className="panel-bright p-6 text-center border-l-4 border-danger" data-testid="rpc-unreachable-banner">
              <div className="text-danger font-display text-2xl mb-1">⚠ RPC UNREACHABLE</div>
              <div className="text-muted text-sm">
                金库地址已配置但无法读取链上状态。请检查 RPC URL 或 Vault 地址（前往 <a href="/admin" className="text-primary underline">/admin</a>）。
              </div>
            </div>
          </div>
        )}

        {/* HERO: 大倒计时 + 奖池 */}
        <section className="max-w-7xl mx-auto px-4 pt-6 md:pt-10 pb-8">
          <div className="grid grid-cols-1 md:grid-cols-12 gap-4 md:gap-6">
            {/* 中央倒计时 */}
            <div className="md:col-span-8 panel field-stripe p-6 md:p-10 relative overflow-hidden" data-testid="hero-timer-panel">
              <div className="flex items-center gap-3 mb-4">
                <div className={`w-2 h-2 rounded-full ${isLive ? "bg-primary live-pulse" : "bg-muted"}`}></div>
                <div className="text-muted text-xs tracking-[0.25em] uppercase">
                  {isLive ? "LIVE · 比赛进行中" : "WAITING · 等待第一脚射门"}
                </div>
                <div className="flex-1"></div>
                <div className="text-muted font-mono text-xs">ROUND #{state?.current_round ?? "—"}</div>
              </div>

              <div
                className={`font-display text-[18vw] md:text-[12vw] leading-none tracking-tighter text-center ${
                  isDanger ? "text-danger timer-glow-red timer-pulse-danger" : "text-white timer-glow-green"
                }`}
                data-testid="countdown-display"
              >
                {fmtTimer(localTimer)}
              </div>

              <div className="text-center text-muted text-sm md:text-base mt-4">
                {localTimer > 0
                  ? <>倒计时归零 → 最后射门者赢得奖池 80% / Last shooter wins 80% when timer hits zero</>
                  : (state?.last_shooter && state?.last_shooter !== "0x0000000000000000000000000000000000000000"
                      ? <>⚽ 比赛可结算 / Ready to settle</>
                      : <>🟢 等待开球 / Waiting for kickoff</>)}
              </div>

              <div className="scoreboard-divider my-6"></div>

              <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-center">
                <Stat label="🎯 最后射门者" value={fmtAddr(state?.last_shooter)} testid="last-shooter" link={state?.last_shooter && state?.last_shooter !== "0x0000000000000000000000000000000000000000" ? explorerUrl(state?.chain_id, "address", state?.last_shooter) : null} />
                <Stat label="📊 本轮射门" value={state?.shot_count ?? 0} testid="shot-count" />
                <Stat label="💰 未派税" value={`${fmtBnb(state?.pending_tax_in_processor_wei ?? "0", 4)}`} unit="BNB" testid="pending-tax" />
              </div>
            </div>

            {/* 右侧奖池 */}
            <div className="md:col-span-4 panel-bright p-6 md:p-8 flex flex-col justify-center items-center" data-testid="hero-pot-panel">
              <div className="text-muted text-xs tracking-[0.25em] uppercase mb-2">CURRENT POT · 当前奖池</div>
              <div className="font-display text-6xl md:text-7xl text-primary timer-glow-green" data-testid="pot-display">
                {fmtBnb(state?.current_pot_wei ?? "0", 4)}
              </div>
              <div className="font-display text-2xl text-muted mt-1">BNB</div>
              <div className="scoreboard-divider w-full my-5"></div>
              <div className="grid grid-cols-2 gap-3 w-full text-center">
                <div>
                  <div className="text-muted text-xs">🏆 赢家分成</div>
                  <div className="font-display text-2xl text-accent">80%</div>
                </div>
                <div>
                  <div className="text-muted text-xs">🔁 滚下一轮</div>
                  <div className="font-display text-2xl text-muted">20%</div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Feed + History */}
        <section className="max-w-7xl mx-auto px-4 pb-12">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <ShotsFeed shots={shots} chainId={state?.chain_id} />
            <RoundsLeaderboard rounds={rounds} chainId={state?.chain_id} />
          </div>
        </section>

        {/* Rules */}
        <Rules vault={state?.vault_address} taxToken={state?.tax_token_address} chainId={state?.chain_id} />

        <Footer />
      </div>
    </div>
  );
}

function Header({ state }) {
  return (
    <header className="border-b border-border-bright sticky top-0 z-50 backdrop-blur-xl bg-bg/80" data-testid="site-header">
      <div className="max-w-7xl mx-auto px-4 py-3 flex items-center gap-4">
        <div className="font-display text-2xl tracking-wide">
          <span className="text-danger">⚽ PENALTY</span>
          <span className="text-primary"> SHOOTOUT</span>
          <span className="text-muted text-sm ml-2 hidden md:inline">点球大战金库</span>
        </div>
        <div className="flex-1"></div>
        <BotStatusBadge state={state} />
        <a href="/admin" className="btn-ghost px-3 py-2 text-xs uppercase tracking-wider" data-testid="admin-link">
          Admin
        </a>
      </div>
    </header>
  );
}

function BotStatusBadge({ state }) {
  if (!state) return null;
  const running = state.bot_running;
  const txt = running ? `🟢 BOT ${state.bot_status?.toUpperCase()}` : "⚫ BOT OFFLINE";
  return (
    <div className={`font-mono text-xs px-3 py-1.5 border ${running ? "border-primary text-primary" : "border-border-bright text-muted"}`} data-testid="bot-status-badge">
      {txt}
    </div>
  );
}

function Stat({ label, value, unit, testid, link }) {
  const content = (
    <>
      <div className="text-muted text-xs tracking-wider mb-1">{label}</div>
      <div className="font-display text-2xl md:text-3xl text-white" data-testid={testid}>
        {value}{unit ? <span className="text-muted text-sm ml-1">{unit}</span> : null}
      </div>
    </>
  );
  if (link) {
    return <a href={link} target="_blank" rel="noreferrer" className="hover:text-primary transition-colors">{content}</a>;
  }
  return <div>{content}</div>;
}

function ShotsFeed({ shots, chainId }) {
  return (
    <div className="panel p-6" data-testid="shots-feed">
      <div className="flex items-center mb-4">
        <div className="font-display text-2xl text-white">⚽ 射门时间线 / SHOTS FEED</div>
        <div className="flex-1"></div>
        <div className="text-muted text-xs">LIVE</div>
      </div>
      <div className="max-h-[420px] overflow-y-auto space-y-2 pr-1">
        {shots.length === 0 ? (
          <div className="text-muted text-center py-12">暂无射门，等待第一脚 ⚽ / No shots yet</div>
        ) : shots.map((s, i) => (
          <div key={`${s.tx_hash}-${s.shot_index}`} className={`flex items-center gap-3 panel-bright p-3 ${i === 0 ? "slide-in border-primary" : ""}`} data-testid={`shot-row-${i}`}>
            <div className="font-display text-2xl text-accent w-12 text-center">#{s.shot_index}</div>
            <div className="flex-1 min-w-0">
              <a href={explorerUrl(chainId, "address", s.shooter)} target="_blank" rel="noreferrer" className="font-mono text-sm text-white hover:text-primary truncate block">
                {fmtAddr(s.shooter)}
              </a>
              <div className="text-muted text-xs">Round #{s.round_id} · {fmtRelativeTime(s.timestamp)}</div>
            </div>
            <div className="text-right">
              <div className="font-display text-lg text-primary">+{fmtBnb(s.value_added_wei, 4)}</div>
              <a href={explorerUrl(chainId, "tx", s.tx_hash)} target="_blank" rel="noreferrer" className="text-muted text-xs hover:text-primary">tx ↗</a>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function RoundsLeaderboard({ rounds, chainId }) {
  return (
    <div className="panel p-6" data-testid="rounds-leaderboard">
      <div className="flex items-center mb-4">
        <div className="font-display text-2xl text-white">🏆 冠军榜 / HALL OF GOALS</div>
        <div className="flex-1"></div>
        <div className="text-muted text-xs">{rounds.length} ROUNDS</div>
      </div>
      <div className="max-h-[420px] overflow-y-auto space-y-2 pr-1">
        {rounds.length === 0 ? (
          <div className="text-muted text-center py-12">暂无冠军 / No champions yet</div>
        ) : rounds.map((r, i) => (
          <div key={r.round_id} className="flex items-center gap-3 panel-bright p-3" data-testid={`round-row-${i}`}>
            <div className="font-display text-3xl text-accent w-16 text-center">#{r.round_id}</div>
            <div className="flex-1 min-w-0">
              <a href={explorerUrl(chainId, "address", r.winner)} target="_blank" rel="noreferrer" className="font-mono text-sm text-white hover:text-primary truncate block">
                🏆 {fmtAddr(r.winner)}
              </a>
              <div className="text-muted text-xs">{r.total_shots} shots · {fmtRelativeTime(r.settled_at)}</div>
            </div>
            <div className="text-right">
              <div className="font-display text-xl text-primary">{fmtBnb(r.prize_wei, 4)}</div>
              <div className="text-muted text-xs">BNB</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Rules({ vault, taxToken, chainId }) {
  const [lang, setLang] = useState("zh");
  return (
    <section className="max-w-7xl mx-auto px-4 pb-12">
      <div className="panel p-8" data-testid="rules-section">
        <div className="flex items-center mb-6">
          <div className="font-display text-3xl text-white">📜 玩法规则 / GAME RULES</div>
          <div className="flex-1"></div>
          <div className="flex gap-2">
            <button onClick={() => setLang("zh")} className={`px-3 py-1.5 text-xs ${lang==='zh' ? 'btn-primary' : 'btn-ghost'}`} data-testid="lang-zh">中文</button>
            <button onClick={() => setLang("en")} className={`px-3 py-1.5 text-xs ${lang==='en' ? 'btn-primary' : 'btn-ghost'}`} data-testid="lang-en">English</button>
          </div>
        </div>
        {lang === "zh" ? (
          <div className="space-y-3 text-muted text-sm md:text-base leading-relaxed">
            <p>⚽ <b className="text-white">这是一场永不停止的世界杯点球大战</b>。每次有人在 Flap 内盘购买代币，监听 Bot 自动识别买家身份并触发"射门"，重置 5 分钟倒计时。</p>
            <p>⏱ <b className="text-white">5 分钟内无人射门</b> → 比赛结束 → 最后射门者获得 <span className="text-primary font-bold">80%</span> 奖池！</p>
            <p>🔁 剩余 <span className="text-accent font-bold">20%</span> 自动滚入下一轮，作为下一回合的起始奖池。</p>
            <p>💰 <b className="text-white">奖池增长方式</b>：每一次交易都会向金库支付税收（佣金后净额），金库越火，奖池越大。</p>
            <p>🤖 <b className="text-white">Bot 自动化</b>：网页后台 7×24 监听链上 Transfer 事件，识别真实买家并代为 shoot，您只需正常买代币即可参与。</p>
            <p>🎯 <b className="text-white">手动模式</b>：钱包用户也可连接钱包直接调用 <code className="font-mono text-primary">vault.buyAndShoot()</code> 一键参与，无需 Bot。</p>
          </div>
        ) : (
          <div className="space-y-3 text-muted text-sm md:text-base leading-relaxed">
            <p>⚽ <b className="text-white">A never-ending World Cup penalty shootout</b>. Each buy on Flap triggers a "shot" — the bot identifies the real buyer and resets the 5-minute timer.</p>
            <p>⏱ <b className="text-white">No shots for 5 minutes</b> → match ends → last shooter takes <span className="text-primary font-bold">80%</span> of the pot!</p>
            <p>🔁 Remaining <span className="text-accent font-bold">20%</span> rolls over to seed the next round.</p>
            <p>💰 <b className="text-white">Growing pot</b>: every trade pays tax to the vault (minus commission). More activity = bigger jackpot.</p>
            <p>🤖 <b className="text-white">Bot automation</b>: 24/7 listener watches on-chain Transfer events, identifies real buyers, and calls shoot() on their behalf.</p>
            <p>🎯 <b className="text-white">Manual mode</b>: Connect wallet and call <code className="font-mono text-primary">vault.buyAndShoot()</code> for one-click participation, no bot required.</p>
          </div>
        )}

        <div className="scoreboard-divider my-6"></div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
          <div>
            <div className="text-muted text-xs uppercase">Vault</div>
            <a href={vault ? explorerUrl(chainId, "address", vault) : "#"} target="_blank" rel="noreferrer" className="font-mono text-white hover:text-primary break-all">{vault || "—"}</a>
          </div>
          <div>
            <div className="text-muted text-xs uppercase">Tax Token</div>
            <a href={taxToken ? explorerUrl(chainId, "address", taxToken) : "#"} target="_blank" rel="noreferrer" className="font-mono text-white hover:text-primary break-all">{taxToken || "—"}</a>
          </div>
          <div>
            <div className="text-muted text-xs uppercase">Chain</div>
            <div className="font-mono text-white">{chainId === 56 ? "BSC Mainnet" : chainId === 97 ? "BSC Testnet" : `Chain ${chainId}`}</div>
          </div>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-border py-6 text-center text-muted text-xs" data-testid="site-footer">
      <div>Built on <a href="https://flap.sh" target="_blank" rel="noreferrer" className="text-primary hover:underline">Flap</a> · VaultPortal V2.1 · BNB Chain</div>
      <div className="mt-1 opacity-50">© 2026 Penalty Shootout Vault. Game on. ⚽</div>
    </footer>
  );
}
