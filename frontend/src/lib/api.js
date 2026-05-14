import axios from "axios";

const BASE = process.env.REACT_APP_BACKEND_URL;
const API = `${BASE}/api`;

export const api = axios.create({ baseURL: API, timeout: 30000 });

// JWT 注入
api.interceptors.request.use((config) => {
  const token = localStorage.getItem("admin_token");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

export const fmtBnb = (wei, decimals = 4) => {
  try {
    const w = BigInt(wei);
    const whole = w / 10n ** 18n;
    const frac = (w % 10n ** 18n).toString().padStart(18, "0").slice(0, decimals);
    return `${whole}.${frac}`;
  } catch {
    return "0.0000";
  }
};

export const fmtAddr = (a) => {
  if (!a || a === "0x0000000000000000000000000000000000000000") return "—";
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
};

export const fmtTimer = (sec) => {
  if (!sec || sec <= 0) return "00:00";
  const m = Math.floor(sec / 60).toString().padStart(2, "0");
  const s = (sec % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
};

export const fmtRelativeTime = (unix) => {
  if (!unix) return "—";
  const now = Math.floor(Date.now() / 1000);
  const diff = now - unix;
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
};

export const explorerUrl = (chainId, type, val) => {
  const base = chainId === 56 ? "https://bscscan.com" : "https://testnet.bscscan.com";
  return `${base}/${type}/${val}`;
};

export const openWebSocket = (onMsg) => {
  const wsUrl = `${BASE.replace(/^http/, "ws")}/api/ws`;
  const ws = new WebSocket(wsUrl);
  ws.onmessage = (e) => {
    try { onMsg(JSON.parse(e.data)); } catch {}
  };
  ws.onopen = () => {
    // keepalive
    const ping = setInterval(() => {
      if (ws.readyState === 1) ws.send("ping");
      else clearInterval(ping);
    }, 30000);
  };
  return ws;
};
