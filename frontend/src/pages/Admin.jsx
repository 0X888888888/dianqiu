import { useEffect, useState } from "react";
import { api, fmtAddr, fmtBnb } from "../lib/api";

export default function Admin() {
  const [token, setToken] = useState(localStorage.getItem("admin_token") || "");
  if (!token) return <Login onLogin={(t) => { localStorage.setItem("admin_token", t); setToken(t); }} />;
  return <AdminPanel onLogout={() => { localStorage.removeItem("admin_token"); setToken(""); }} />;
}

function Login({ onLogin }) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setErr(""); setLoading(true);
    try {
      const r = await api.post("/admin/login", { username, password });
      onLogin(r.data.token);
    } catch (e) {
      setErr(e.response?.data?.detail || "登录失败 / Login failed");
    } finally { setLoading(false); }
  };

  return (
    <div className="min-h-screen stadium-bg field-lines flex items-center justify-center p-4" data-testid="admin-login-page">
      <div className="panel-bright p-8 max-w-md w-full">
        <div className="font-display text-3xl text-white mb-1">⚽ ADMIN</div>
        <div className="text-muted text-sm mb-6">管理员登录 / Admin Login</div>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <div className="text-muted text-xs uppercase mb-1">Username</div>
            <input value={username} onChange={(e) => setUsername(e.target.value)} data-testid="login-username" />
          </div>
          <div>
            <div className="text-muted text-xs uppercase mb-1">Password</div>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} data-testid="login-password" />
          </div>
          {err && <div className="text-danger text-sm" data-testid="login-error">{err}</div>}
          <button type="submit" disabled={loading} className="btn-primary px-6 py-3 w-full" data-testid="login-submit">
            {loading ? "Loading…" : "登录 / Login"}
          </button>
        </form>
        <div className="text-muted text-xs mt-4">
          默认账户 / Default: admin / shootout2026<br/>
          请尽快修改环境变量 ADMIN_PASSWORD
        </div>
      </div>
    </div>
  );
}

function AdminPanel({ onLogout }) {
  const [cfg, setCfg] = useState(null);
  const [botStatus, setBotStatus] = useState(null);
  const [logs, setLogs] = useState([]);
  const [savingMsg, setSavingMsg] = useState("");
  const [generatedKey, setGeneratedKey] = useState(null);

  const load = async () => {
    try {
      const [c, b, l] = await Promise.all([
        api.get("/admin/config"),
        api.get("/admin/bot/status"),
        api.get("/admin/bot/logs?limit=50"),
      ]);
      setCfg(c.data);
      setBotStatus(b.data);
      setLogs(l.data);
    } catch (e) {
      if (e.response?.status === 401) onLogout();
    }
  };

  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, []);

  const save = async (patch) => {
    setSavingMsg("Saving…");
    try {
      const r = await api.put("/admin/config", patch);
      setCfg(r.data);
      setSavingMsg("✓ Saved");
      setTimeout(() => setSavingMsg(""), 2000);
    } catch (e) {
      setSavingMsg(`✕ ${e.response?.data?.detail || e.message}`);
    }
  };

  const startBot = async () => { await api.post("/admin/bot/start"); load(); };
  const stopBot = async () => { await api.post("/admin/bot/stop"); load(); };
  const generateWallet = async () => {
    if (!confirm("生成新的 Keeper 钱包？私钥仅显示一次，必须备份。")) return;
    const r = await api.post("/admin/wallet/generate");
    setGeneratedKey(r.data);
    load();
  };

  if (!cfg) return <div className="min-h-screen stadium-bg flex items-center justify-center text-muted">Loading…</div>;

  return (
    <div className="min-h-screen bg-bg p-4 md:p-8" data-testid="admin-panel">
      <div className="max-w-6xl mx-auto">
        <header className="flex items-center mb-6">
          <div>
            <div className="font-display text-3xl text-white">⚽ ADMIN PANEL</div>
            <div className="text-muted text-sm">管理后台 / Penalty Shootout Vault</div>
          </div>
          <div className="flex-1"></div>
          {savingMsg && <span className="text-primary text-sm mr-4">{savingMsg}</span>}
          <a href="/" className="btn-ghost px-3 py-2 text-xs mr-2">← Dashboard</a>
          <button onClick={onLogout} className="btn-ghost px-3 py-2 text-xs" data-testid="logout-btn">Logout</button>
        </header>

        {generatedKey && (
          <div className="panel-bright p-6 mb-6 border-l-4 border-accent" data-testid="new-wallet-banner">
            <div className="font-display text-2xl text-accent">⚠ NEW KEEPER WALLET GENERATED</div>
            <div className="text-white mt-2">Address: <code className="font-mono">{generatedKey.address}</code></div>
            <div className="text-danger mt-2">Private Key (仅显示一次！): </div>
            <div className="bg-bg p-3 mt-1 font-mono text-xs break-all border border-danger">{generatedKey.private_key}</div>
            <div className="text-muted text-sm mt-3">⚠ {generatedKey.warning}</div>
            <button onClick={() => setGeneratedKey(null)} className="btn-primary px-4 py-2 mt-4 text-sm">已备份，关闭</button>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Config */}
          <div className="panel p-6">
            <div className="font-display text-2xl mb-4">⚙ Vault 配置</div>
            <Field label="Chain ID" value={cfg.chain_id} type="number"
              onSave={(v) => save({ chain_id: Number(v) })} testid="cfg-chain-id"
              hint="56 = BSC Mainnet, 97 = BSC Testnet" />
            <Field label="RPC URL" value={cfg.rpc_url}
              onSave={(v) => save({ rpc_url: v })} testid="cfg-rpc"
              hint="BSC 节点。可用 https://data-seed-prebsc-1-s1.binance.org:8545" />
            <Field label="Factory Address" value={cfg.factory_address}
              onSave={(v) => save({ factory_address: v })} testid="cfg-factory"
              hint="您部署的 PenaltyShootoutVaultFactory 地址（备查）" />
            <Field label="Vault Address" value={cfg.vault_address}
              onSave={(v) => save({ vault_address: v })} testid="cfg-vault"
              hint="发币后从 VaultPortal.tryGetVault 获得的金库地址" />
            <Field label="Tax Token Address" value={cfg.tax_token_address}
              onSave={(v) => save({ tax_token_address: v })} testid="cfg-token"
              hint="您发行的 Flap V3 税收代币地址" />
            <Field label="轮询间隔（秒）" value={cfg.poll_interval_seconds} type="number"
              onSave={(v) => save({ poll_interval_seconds: Number(v) })} testid="cfg-poll"
              hint="Bot 扫描区块的频率，推荐 3-10 秒" />
            <div className="mt-4">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={cfg.auto_shoot_enabled}
                  onChange={(e) => save({ auto_shoot_enabled: e.target.checked })}
                  className="w-4 h-4" data-testid="cfg-auto-shoot" />
                <span className="text-white">启用自动 Shoot / Enable Auto-Shoot</span>
              </label>
              <div className="text-muted text-xs ml-6">关闭后 Bot 仅监听不发送交易</div>
            </div>
          </div>

          {/* Keeper Wallet */}
          <div className="panel p-6">
            <div className="font-display text-2xl mb-4">🔐 Keeper 钱包</div>
            <div className="space-y-3">
              <div>
                <div className="text-muted text-xs uppercase mb-1">Address</div>
                <div className="font-mono text-white break-all" data-testid="keeper-address">
                  {cfg.keeper_address || "—"}
                </div>
              </div>
              <div>
                <div className="text-muted text-xs uppercase mb-1">Private Key Status</div>
                <div className="font-mono text-sm">
                  {cfg.keeper_private_key_set
                    ? <span className="text-primary">✓ 已配置（加密存储）</span>
                    : <span className="text-danger">✕ 未配置</span>}
                </div>
              </div>
            </div>

            <div className="scoreboard-divider my-4"></div>

            <PrivateKeyInput onSave={(pk) => save({ keeper_private_key: pk })} />

            <button onClick={generateWallet} className="btn-ghost px-4 py-2 mt-4 w-full text-sm" data-testid="generate-wallet-btn">
              🎲 自动生成新 Keeper 钱包
            </button>

            <div className="text-muted text-xs mt-3 leading-relaxed">
              ⚠ Keeper 钱包专用于自动 shoot，请充值少量 BNB（推荐 0.1~0.3）作为 gas。<br/>
              ⚠ 私钥 AES 加密后存于数据库，但仍建议生产环境定期轮换。
            </div>
          </div>

          {/* Bot Status */}
          <div className="panel p-6">
            <div className="font-display text-2xl mb-4">🤖 Bot 控制</div>
            <div className="grid grid-cols-2 gap-3 mb-4">
              <div className="panel-bright p-3 text-center">
                <div className="text-muted text-xs">STATUS</div>
                <div className="font-display text-xl text-white" data-testid="bot-status">{botStatus?.status?.toUpperCase() || "IDLE"}</div>
              </div>
              <div className="panel-bright p-3 text-center">
                <div className="text-muted text-xs">LAST BLOCK</div>
                <div className="font-display text-xl text-primary">{botStatus?.last_block || 0}</div>
              </div>
            </div>
            <div className="flex gap-3">
              <button onClick={startBot} disabled={botStatus?.running} className="btn-primary px-4 py-2 flex-1" data-testid="start-bot-btn">▶ Start</button>
              <button onClick={stopBot} disabled={!botStatus?.running} className="btn-danger px-4 py-2 flex-1" data-testid="stop-bot-btn">■ Stop</button>
            </div>
            {botStatus?.last_error && (
              <div className="text-danger text-xs mt-3 break-all">Last error: {botStatus.last_error}</div>
            )}
            {botStatus?.recent_buyers?.length > 0 && (
              <div className="mt-4">
                <div className="text-muted text-xs uppercase mb-1">Recent Buyers (60s window)</div>
                <div className="space-y-1">
                  {botStatus.recent_buyers.map((a) => (
                    <div key={a} className="font-mono text-xs text-white">{fmtAddr(a)}</div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Logs */}
          <div className="panel p-6">
            <div className="font-display text-2xl mb-4">📜 Bot 日志</div>
            <div className="max-h-[420px] overflow-y-auto space-y-1 pr-1 font-mono text-xs" data-testid="bot-logs">
              {logs.length === 0
                ? <div className="text-muted text-center py-6">暂无日志</div>
                : logs.map((l, i) => (
                  <div key={i} className={`flex gap-2 ${l.level === "error" ? "text-danger" : l.level === "warn" ? "text-accent" : "text-white"}`}>
                    <span className="text-muted">{l.timestamp?.slice(11, 19)}</span>
                    <span className="text-muted">[{l.level}]</span>
                    <span className="flex-1 break-all">{l.message}</span>
                  </div>
                ))
              }
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, type, onSave, testid, hint }) {
  const [v, setV] = useState(value || "");
  useEffect(() => setV(value || ""), [value]);
  const dirty = String(v) !== String(value || "");
  return (
    <div className="mb-3">
      <div className="text-muted text-xs uppercase mb-1 flex items-center gap-2">
        {label} {dirty && <span className="text-accent">●</span>}
      </div>
      <div className="flex gap-2">
        <input type={type || "text"} value={v} onChange={(e) => setV(e.target.value)} data-testid={testid} />
        <button onClick={() => onSave(v)} disabled={!dirty} className="btn-primary px-4 text-xs">Save</button>
      </div>
      {hint && <div className="text-muted text-xs mt-1">{hint}</div>}
    </div>
  );
}

function PrivateKeyInput({ onSave }) {
  const [pk, setPk] = useState("");
  const save = () => {
    if (!pk.trim()) return;
    if (!confirm("确认导入此 Keeper 私钥？私钥会被加密存储。")) return;
    onSave(pk.trim());
    setPk("");
  };
  return (
    <div>
      <div className="text-muted text-xs uppercase mb-1">导入现有 Keeper 私钥 (Hex)</div>
      <input type="password" placeholder="0x..." value={pk} onChange={(e) => setPk(e.target.value)} data-testid="keeper-pk-input" />
      <button onClick={save} disabled={!pk.trim()} className="btn-primary px-4 py-2 mt-2 w-full text-sm" data-testid="keeper-pk-save">导入并加密保存</button>
    </div>
  );
}
