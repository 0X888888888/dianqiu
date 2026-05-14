"""
Penalty Shootout Vault - 后端服务
─────────────────────────────────────────
- Admin 登录 / 配置存储
- Keeper 私钥加密存储
- BSC 监听 Worker（自动 shoot）
- Game state API（公开）
- WebSocket 实时推送
"""
import os
import asyncio
import json
import logging
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import List, Optional, Dict, Any

import bcrypt
import jwt
from cryptography.fernet import Fernet
from dotenv import load_dotenv
from fastapi import FastAPI, APIRouter, Depends, HTTPException, status, WebSocket, WebSocketDisconnect
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel, Field, ConfigDict
from starlette.middleware.cors import CORSMiddleware
from web3 import Web3
from web3.middleware import ExtraDataToPOAMiddleware
from eth_account import Account

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

# ─── Config ────────────────────────────────────────────────
MONGO_URL = os.environ['MONGO_URL']
DB_NAME = os.environ['DB_NAME']
JWT_SECRET = os.environ.get('JWT_SECRET', 'change-me-in-prod-please')
JWT_ALG = 'HS256'
JWT_EXP_HOURS = 24
ENCRYPTION_SEED = os.environ.get('ENCRYPTION_SEED', 'flap-penalty-vault-default-seed-change-me')
DEFAULT_ADMIN_USERNAME = os.environ.get('ADMIN_USERNAME', 'admin')
DEFAULT_ADMIN_PASSWORD = os.environ.get('ADMIN_PASSWORD', 'changeme')

# 默认 RPC（用户可在管理后台改）
# BSC 主网推荐 publicnode（更宽松的速率限制），也可用 LlamaRPC、1RPC、Ankr 等
DEFAULT_RPC_TESTNET = "https://data-seed-prebsc-1-s1.binance.org:8545"
DEFAULT_RPC_MAINNET = "https://bsc-rpc.publicnode.com"

logger = logging.getLogger("vault-server")
logging.basicConfig(level=logging.INFO, format='%(asctime)s | %(levelname)s | %(name)s | %(message)s')

# ─── Encryption ────────────────────────────────────────────
def _derive_fernet_key(seed: str) -> bytes:
    """从字符串种子派生稳定的 Fernet key"""
    import hashlib
    import base64
    h = hashlib.sha256(seed.encode()).digest()
    return base64.urlsafe_b64encode(h)

fernet = Fernet(_derive_fernet_key(ENCRYPTION_SEED))

def encrypt_str(plain: str) -> str:
    return fernet.encrypt(plain.encode()).decode()

def decrypt_str(token: str) -> str:
    return fernet.decrypt(token.encode()).decode()

# ─── MongoDB ──────────────────────────────────────────────
client = AsyncIOMotorClient(MONGO_URL)
db = client[DB_NAME]
col_config = db['config']
col_admin = db['admin']
col_rounds = db['rounds']
col_shots = db['shots']
col_bot_logs = db['bot_logs']

# ─── Pydantic Models ──────────────────────────────────────
class AdminLoginRequest(BaseModel):
    username: str
    password: str

class AdminLoginResponse(BaseModel):
    token: str
    expires_at: str

class VaultConfig(BaseModel):
    model_config = ConfigDict(extra="ignore")
    chain_id: int = 97  # 97 = BSC testnet, 56 = BSC mainnet
    rpc_url: str = DEFAULT_RPC_TESTNET
    vault_address: str = ""
    tax_token_address: str = ""
    factory_address: str = ""
    keeper_address: str = ""
    keeper_private_key_encrypted: str = ""
    poll_interval_seconds: int = 5
    auto_shoot_enabled: bool = False

class VaultConfigUpdate(BaseModel):
    chain_id: Optional[int] = None
    rpc_url: Optional[str] = None
    vault_address: Optional[str] = None
    tax_token_address: Optional[str] = None
    factory_address: Optional[str] = None
    keeper_private_key: Optional[str] = None  # 明文输入；存储时加密
    poll_interval_seconds: Optional[int] = None
    auto_shoot_enabled: Optional[bool] = None

class GameState(BaseModel):
    configured: bool
    rpc_ok: bool = False
    chain_id: int = 0
    vault_address: str = ""
    tax_token_address: str = ""
    current_round: int = 0
    current_pot_wei: str = "0"
    last_shooter: str = ""
    time_remaining_seconds: int = 0
    deadline_unix: int = 0
    shot_count: int = 0
    pending_tax_in_processor_wei: str = "0"
    description: str = ""
    bot_running: bool = False
    bot_status: str = "idle"
    last_block: int = 0
    keeper_address: str = ""
    keeper_balance_bnb: str = "0"
    updated_at: str = ""

class RoundRecord(BaseModel):
    round_id: int
    winner: str
    prize_wei: str
    settled_at: int
    total_shots: int
    tx_hash: str = ""

class ShotRecord(BaseModel):
    round_id: int
    shooter: str
    value_added_wei: str
    new_deadline: int
    pot_after_wei: str
    shot_index: int
    block_number: int
    tx_hash: str
    timestamp: int

class BotLogEntry(BaseModel):
    level: str
    message: str
    timestamp: str

# ─── Auth helpers ─────────────────────────────────────────
security = HTTPBearer()

def create_jwt(username: str) -> dict:
    exp = datetime.now(timezone.utc) + timedelta(hours=JWT_EXP_HOURS)
    payload = {"sub": username, "exp": exp}
    token = jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALG)
    return {"token": token, "expires_at": exp.isoformat()}

def verify_jwt(creds: HTTPAuthorizationCredentials = Depends(security)) -> str:
    try:
        payload = jwt.decode(creds.credentials, JWT_SECRET, algorithms=[JWT_ALG])
        return payload['sub']
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="invalid_token")

# ─── ABI (minimal for Vault & TaxToken) ──────────────────
VAULT_ABI = json.loads("""
[
{"type":"function","name":"currentRound","inputs":[],"outputs":[{"type":"uint256"}],"stateMutability":"view"},
{"type":"function","name":"currentPot","inputs":[],"outputs":[{"type":"uint256"}],"stateMutability":"view"},
{"type":"function","name":"lastShooter","inputs":[],"outputs":[{"type":"address"}],"stateMutability":"view"},
{"type":"function","name":"shotCount","inputs":[],"outputs":[{"type":"uint256"}],"stateMutability":"view"},
{"type":"function","name":"deadline","inputs":[],"outputs":[{"type":"uint256"}],"stateMutability":"view"},
{"type":"function","name":"timeRemaining","inputs":[],"outputs":[{"type":"uint256"}],"stateMutability":"view"},
{"type":"function","name":"pendingTaxInProcessor","inputs":[],"outputs":[{"type":"uint256"}],"stateMutability":"view"},
{"type":"function","name":"taxToken","inputs":[],"outputs":[{"type":"address"}],"stateMutability":"view"},
{"type":"function","name":"shotWindow","inputs":[],"outputs":[{"type":"uint256"}],"stateMutability":"view"},
{"type":"function","name":"minShotValue","inputs":[],"outputs":[{"type":"uint256"}],"stateMutability":"view"},
{"type":"function","name":"keeperFeeBps","inputs":[],"outputs":[{"type":"uint256"}],"stateMutability":"view"},
{"type":"function","name":"lastShotPotMark","inputs":[],"outputs":[{"type":"uint256"}],"stateMutability":"view"},
{"type":"function","name":"description","inputs":[],"outputs":[{"type":"string"}],"stateMutability":"view"},
{"type":"function","name":"shoot","inputs":[{"name":"player","type":"address"}],"outputs":[],"stateMutability":"nonpayable"},
{"type":"function","name":"settleRound","inputs":[],"outputs":[],"stateMutability":"nonpayable"},
{"type":"event","name":"ShotFired","inputs":[
  {"name":"round","type":"uint256","indexed":true},
  {"name":"shooter","type":"address","indexed":true},
  {"name":"valueAdded","type":"uint256","indexed":false},
  {"name":"newDeadline","type":"uint256","indexed":false},
  {"name":"potAfter","type":"uint256","indexed":false},
  {"name":"shotIndex","type":"uint256","indexed":false}
],"anonymous":false},
{"type":"event","name":"GoalScored","inputs":[
  {"name":"round","type":"uint256","indexed":true},
  {"name":"winner","type":"address","indexed":true},
  {"name":"prize","type":"uint256","indexed":false},
  {"name":"carriedOver","type":"uint256","indexed":false},
  {"name":"totalShots","type":"uint256","indexed":false}
],"anonymous":false}
]
""")

ERC20_TRANSFER_TOPIC = "0x" + Web3.keccak(text="Transfer(address,address,uint256)").hex().removeprefix("0x")

# ─── Bot Manager ──────────────────────────────────────────
class BotManager:
    def __init__(self):
        self.task: Optional[asyncio.Task] = None
        self.running = False
        self.status = "idle"
        self.last_block = 0
        self.last_error = ""
        self.last_buyers: Dict[str, int] = {}  # address -> timestamp 最近购买者池
        self.ws_clients: List[WebSocket] = []
        self._stop_flag = False
        self._last_ratelimit_log = 0

    async def broadcast(self, event_type: str, data: dict):
        """向所有 WS 客户端推送事件"""
        msg = json.dumps({"type": event_type, "data": data, "timestamp": int(time.time())})
        dead = []
        for ws in self.ws_clients:
            try:
                await ws.send_text(msg)
            except Exception:
                dead.append(ws)
        for ws in dead:
            try:
                self.ws_clients.remove(ws)
            except ValueError:
                pass

    async def log(self, level: str, message: str):
        entry = {"level": level, "message": message, "timestamp": datetime.now(timezone.utc).isoformat()}
        await col_bot_logs.insert_one(entry)
        # 保留最近 500 条
        count = await col_bot_logs.count_documents({})
        if count > 500:
            oldest = await col_bot_logs.find({}, {"_id": 1}).sort([("_id", 1)]).limit(count - 500).to_list(length=count - 500)
            ids = [doc['_id'] for doc in oldest]
            if ids:
                await col_bot_logs.delete_many({"_id": {"$in": ids}})
        logger.log(getattr(logging, level.upper(), logging.INFO), f"[BOT] {message}")
        await self.broadcast("log", {"level": level, "message": message})

    async def start(self):
        if self.running:
            return
        self._stop_flag = False
        self.task = asyncio.create_task(self._run_loop())
        self.running = True
        await self.log("info", "Bot 启动")

    async def stop(self):
        if not self.running:
            return
        self._stop_flag = True
        self.running = False
        self.status = "stopped"
        if self.task:
            try:
                await asyncio.wait_for(self.task, timeout=5)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                self.task.cancel()
        await self.log("info", "Bot 停止")

    async def _run_loop(self):
        """主监听循环"""
        try:
            cfg = await get_config()
            if not cfg.vault_address or not cfg.tax_token_address:
                self.status = "config_missing"
                await self.log("error", "未配置 vault 或 taxToken 地址")
                self.running = False
                return

            w3 = Web3(Web3.HTTPProvider(cfg.rpc_url))
            if not w3.is_connected():
                self.status = "rpc_error"
                await self.log("error", f"无法连接 RPC: {cfg.rpc_url}")
                self.running = False
                return

            await self.log("info", f"已连接 RPC, chainId={cfg.chain_id}, vault={cfg.vault_address}")

            vault = w3.eth.contract(address=Web3.to_checksum_address(cfg.vault_address), abi=VAULT_ABI)
            tax_token_addr = Web3.to_checksum_address(cfg.tax_token_address)

            # 同步起始区块（首次启动时往前回退 1500 块约 1.5 小时，确保不漏事件）
            current_block = w3.eth.block_number
            if self.last_block == 0:
                self.last_block = max(0, current_block - 1500)

            self.status = "running"
            poll_interval = max(2, cfg.poll_interval_seconds)

            while not self._stop_flag:
                try:
                    cfg = await get_config()  # 重新加载配置（用户可能改了）
                    poll_interval = max(2, cfg.poll_interval_seconds)

                    head = w3.eth.block_number
                    if head > self.last_block:
                        # batch 500 块，publicnode 支持
                        safe_head = max(0, head - 1)
                        to_block = min(self.last_block + 500, safe_head)
                        if to_block > self.last_block:
                            ok1 = await self._scan_transfers(w3, tax_token_addr, self.last_block + 1, to_block)
                            ok2 = await self._scan_vault_events(w3, vault, self.last_block + 1, to_block)
                            if ok1 and ok2:
                                self.last_block = to_block

                    # 3. 推送当前游戏状态
                    state = await build_game_state()
                    await self.broadcast("state", state)

                    # 4. 自动 shoot 决策
                    if cfg.auto_shoot_enabled:
                        await self._maybe_auto_shoot(w3, vault, cfg)

                    # 5. 自动 settleRound（去信任）
                    await self._maybe_settle(w3, vault, cfg)

                except Exception as e:
                    self.last_error = str(e)
                    await self.log("warn", f"循环错误: {e}")

                await asyncio.sleep(poll_interval)
        except asyncio.CancelledError:
            pass
        except Exception as e:
            self.status = "crashed"
            self.last_error = str(e)
            await self.log("error", f"主循环崩溃: {e}")
        finally:
            self.running = False

    async def _scan_transfers(self, w3, tax_token: str, from_block: int, to_block: int):
        """扫 TaxToken Transfer 事件，识别真实买家。

        FLAP 内盘购买的 token 路径是多跳的：
            FLAP Portal → 中间合约 → 真实买家
        所以不能直接用 Transfer.to 作为买家，需要按 tx 分组后找出
        '最终接收者'（其 to 没再作为 from 出现）。
        """
        try:
            logs = w3.eth.get_logs({
                "fromBlock": hex(from_block),
                "toBlock": hex(to_block),
                "address": tax_token,
                "topics": [ERC20_TRANSFER_TOPIC],
            })
        except Exception as e:
            err = str(e)
            now = int(time.time())
            if "limit" in err.lower() or "429" in err or "32005" in err:
                if now - self._last_ratelimit_log > 60:
                    await self.log("warn", f"RPC 速率限制（建议换 RPC）：{err[:120]}")
                    self._last_ratelimit_log = now
            else:
                await self.log("warn", f"扫 Transfer 失败 [{from_block}-{to_block}]: {err[:120]}")
            return False

        # 按 tx_hash 分组
        by_tx = {}
        for lg in logs:
            try:
                txh = lg["transactionHash"].hex() if hasattr(lg["transactionHash"], "hex") else str(lg["transactionHash"])
                fr_addr = "0x" + lg["topics"][1].hex()[-40:]
                to_addr = "0x" + lg["topics"][2].hex()[-40:]
                by_tx.setdefault(txh, []).append((fr_addr.lower(), to_addr.lower()))
            except Exception:
                continue

        new_buyers_count = 0
        for txh, transfers in by_tx.items():
            # 找该 tx 内所有作为 from 出现过的地址
            froms = {fr for fr, _ in transfers}
            # 真实买家 = 作为 to 但从未作为 from（即代币流的终点）
            finals = []
            for _, to_addr in transfers:
                if (to_addr not in froms
                    and int(to_addr, 16) != 0
                    and to_addr != "0x000000000000000000000000000000000000dead"
                    and to_addr != tax_token.lower()):
                    finals.append(to_addr)
            if finals:
                # 取最后一个（最终的最终）
                real_buyer = Web3.to_checksum_address(finals[-1])
                self.last_buyers[real_buyer] = int(time.time())
                new_buyers_count += 1

        if new_buyers_count > 0:
            await self.log("info", f"🎯 扫到 {new_buyers_count} 笔买入 [{from_block}-{to_block}]，最新买家={list(self.last_buyers.keys())[-1][:10]}...")

        # 清理 90s 以上的旧记录
        cutoff = int(time.time()) - 90
        self.last_buyers = {a: t for a, t in self.last_buyers.items() if t > cutoff}
        return True

    async def _scan_vault_events(self, w3, vault, from_block: int, to_block: int):
        """扫 vault 的 ShotFired / GoalScored 事件，同步进数据库"""
        try:
            shot_evt = vault.events.ShotFired()
            goal_evt = vault.events.GoalScored()
            shot_logs = shot_evt.get_logs(from_block=from_block, to_block=to_block)
            goal_logs = goal_evt.get_logs(from_block=from_block, to_block=to_block)
        except Exception as e:
            err = str(e)
            now = int(time.time())
            if "limit" in err.lower() or "429" in err or "32005" in err:
                if now - self._last_ratelimit_log > 60:
                    await self.log("warn", f"RPC 速率限制（建议换 RPC）：{err[:120]}")
                    self._last_ratelimit_log = now
            else:
                await self.log("warn", f"扫 vault 事件失败 [{from_block}-{to_block}]: {err[:120]}")
            return False

        try:
            for lg in shot_logs:
                # 直接用当前时间作 timestamp，绕开 web3.py POA middleware 问题（BSC 是 POA）
                # 因为 scan 几乎实时，差距极小
                ts = int(time.time())
                txh = lg["transactionHash"].hex() if hasattr(lg["transactionHash"], "hex") else str(lg["transactionHash"])
                if not txh.startswith("0x"):
                    txh = "0x" + txh
                doc = {
                    "round_id": int(lg["args"]["round"]),
                    "shooter": str(lg["args"]["shooter"]),
                    "value_added_wei": str(lg["args"]["valueAdded"]),
                    "new_deadline": int(lg["args"]["newDeadline"]),
                    "pot_after_wei": str(lg["args"]["potAfter"]),
                    "shot_index": int(lg["args"]["shotIndex"]),
                    "block_number": int(lg["blockNumber"]),
                    "tx_hash": txh,
                    "timestamp": ts,
                }
                await col_shots.update_one(
                    {"tx_hash": doc["tx_hash"], "shot_index": doc["shot_index"]},
                    {"$set": doc}, upsert=True
                )
                await self.broadcast("shot", doc)
                await self.log("info", f"⚽ Shot detected: round#{doc['round_id']} by {doc['shooter']}")

            for lg in goal_logs:
                txh = lg["transactionHash"].hex() if hasattr(lg["transactionHash"], "hex") else str(lg["transactionHash"])
                if not txh.startswith("0x"):
                    txh = "0x" + txh
                doc = {
                    "round_id": int(lg["args"]["round"]),
                    "winner": str(lg["args"]["winner"]),
                    "prize_wei": str(lg["args"]["prize"]),
                    "carried_over_wei": str(lg["args"]["carriedOver"]),
                    "total_shots": int(lg["args"]["totalShots"]),
                    "settled_at": int(time.time()),
                    "tx_hash": txh,
                }
                await col_rounds.update_one(
                    {"round_id": doc["round_id"]},
                    {"$set": doc}, upsert=True
                )
                await self.broadcast("goal", doc)
                await self.log("info", f"🏆 GOAL! Round#{doc['round_id']} winner={doc['winner']} prize={doc['prize_wei']} wei")
        except Exception as e:
            await self.log("warn", f"处理 vault 事件失败: {str(e)[:160]}")
            return False
        return True

    async def _maybe_auto_shoot(self, w3, vault, cfg: VaultConfig):
        """检查是否应该自动 shoot
        新逻辑：基于 currentPot 与 lastShotPotMark 的差额判断"""
        if not cfg.keeper_private_key_encrypted:
            return

        try:
            current_pot = vault.functions.currentPot().call()
            last_mark = vault.functions.lastShotPotMark().call()
            min_shot = vault.functions.minShotValue().call()

            new_amount = current_pot - last_mark
            if new_amount < min_shot:
                return  # 还没到门槛

            # 选最近 60s 内最新的买家；如果没有就直接用 keeper 自己（作为兜底，确保游戏跑起来）
            if self.last_buyers:
                latest_buyer = max(self.last_buyers.items(), key=lambda kv: kv[1])
                buyer_addr = latest_buyer[0]
            else:
                # 兜底：直接用 keeper 地址作为 player（让游戏跑起来，不致死锁奖池）
                acct = Account.from_key(decrypt_str(cfg.keeper_private_key_encrypted))
                buyer_addr = acct.address
                await self.log("info", f"无识别到买家，兜底用 keeper 地址 {buyer_addr[:10]}... 作为 shooter")

            # 检查 cooldown：同一买家 20s 内不重复 shoot（防 spam）
            recent = await col_shots.find_one(
                {"shooter": buyer_addr},
                sort=[("timestamp", -1)]
            )
            if recent and int(time.time()) - recent.get("timestamp", 0) < 20:
                return

            await self.log("info", f"⚽ 触发 shoot: pot+{new_amount} wei, player={buyer_addr[:10]}...")
            await self._send_shoot(w3, vault, cfg, buyer_addr)
        except Exception as e:
            await self.log("warn", f"_maybe_auto_shoot 错误: {str(e)[:160]}")

    async def _maybe_settle(self, w3, vault, cfg: VaultConfig):
        """倒计时归零自动结算（任何人可调，无需私钥）"""
        try:
            time_left = vault.functions.timeRemaining().call()
            deadline = vault.functions.deadline().call()
            last_shooter = vault.functions.lastShooter().call()
            if time_left == 0 and deadline > 0 and int(last_shooter, 16) != 0:
                if not cfg.keeper_private_key_encrypted:
                    return
                await self.log("info", f"倒计时到期，触发 settleRound")
                priv = decrypt_str(cfg.keeper_private_key_encrypted)
                acct = Account.from_key(priv)
                tx = vault.functions.settleRound().build_transaction({
                    "from": acct.address,
                    "nonce": w3.eth.get_transaction_count(acct.address),
                    "gas": 500000,
                    "gasPrice": w3.eth.gas_price,
                    "chainId": cfg.chain_id,
                })
                signed = acct.sign_transaction(tx)
                txh = w3.eth.send_raw_transaction(signed.raw_transaction)
                await self.log("info", f"settleRound tx: {txh.hex()}")
        except Exception as e:
            await self.log("warn", f"_maybe_settle 错误: {e}")

    async def _send_shoot(self, w3, vault, cfg: VaultConfig, player: str):
        try:
            priv = decrypt_str(cfg.keeper_private_key_encrypted)
            acct = Account.from_key(priv)
            tx = vault.functions.shoot(Web3.to_checksum_address(player)).build_transaction({
                "from": acct.address,
                "nonce": w3.eth.get_transaction_count(acct.address),
                "gas": 1500000,
                "gasPrice": w3.eth.gas_price,
                "chainId": cfg.chain_id,
            })
            signed = acct.sign_transaction(tx)
            txh = w3.eth.send_raw_transaction(signed.raw_transaction)
            await self.log("info", f"⚽ Auto-shoot for {player[:10]}...: tx={txh.hex()}")
        except Exception as e:
            await self.log("warn", f"_send_shoot 失败: {e}")


bot_manager = BotManager()

# ─── Helpers ──────────────────────────────────────────────
async def get_config() -> VaultConfig:
    doc = await col_config.find_one({"_id": "main"}, {"_id": 0})
    if not doc:
        # 创建默认配置
        cfg = VaultConfig()
        await col_config.update_one({"_id": "main"}, {"$set": cfg.model_dump()}, upsert=True)
        return cfg
    return VaultConfig(**doc)

async def update_config(patch: VaultConfigUpdate) -> VaultConfig:
    cur = await get_config()
    data = cur.model_dump()
    update_dict = patch.model_dump(exclude_unset=True)
    if 'keeper_private_key' in update_dict:
        pk = update_dict.pop('keeper_private_key')
        if pk:
            # 验证私钥并存加密
            try:
                acct = Account.from_key(pk)
                data['keeper_address'] = acct.address
                data['keeper_private_key_encrypted'] = encrypt_str(pk)
            except Exception:
                raise HTTPException(status_code=400, detail="invalid_private_key")
    for k, v in update_dict.items():
        data[k] = v
    await col_config.update_one({"_id": "main"}, {"$set": data}, upsert=True)
    return VaultConfig(**data)

async def ensure_admin():
    doc = await col_admin.find_one({"username": DEFAULT_ADMIN_USERNAME})
    if not doc:
        pwhash = bcrypt.hashpw(DEFAULT_ADMIN_PASSWORD.encode(), bcrypt.gensalt()).decode()
        await col_admin.insert_one({"username": DEFAULT_ADMIN_USERNAME, "password_hash": pwhash})
        logger.info(f"已创建默认管理员账户: {DEFAULT_ADMIN_USERNAME}")

async def build_game_state() -> dict:
    cfg = await get_config()
    state = GameState(
        configured=bool(cfg.vault_address),
        chain_id=cfg.chain_id,
        vault_address=cfg.vault_address,
        tax_token_address=cfg.tax_token_address,
        keeper_address=cfg.keeper_address,
        bot_running=bot_manager.running,
        bot_status=bot_manager.status,
        last_block=bot_manager.last_block,
        updated_at=datetime.now(timezone.utc).isoformat(),
    )
    if not cfg.vault_address:
        return state.model_dump()
    try:
        w3 = Web3(Web3.HTTPProvider(cfg.rpc_url))
        vault = w3.eth.contract(address=Web3.to_checksum_address(cfg.vault_address), abi=VAULT_ABI)
        state.current_round = vault.functions.currentRound().call()
        state.current_pot_wei = str(vault.functions.currentPot().call())
        state.last_shooter = vault.functions.lastShooter().call()
        state.shot_count = vault.functions.shotCount().call()
        state.deadline_unix = vault.functions.deadline().call()
        state.time_remaining_seconds = vault.functions.timeRemaining().call()
        state.pending_tax_in_processor_wei = str(vault.functions.pendingTaxInProcessor().call())
        state.description = vault.functions.description().call()
        if cfg.keeper_address:
            bal = w3.eth.get_balance(Web3.to_checksum_address(cfg.keeper_address))
            state.keeper_balance_bnb = str(bal)
        state.rpc_ok = True
    except Exception as e:
        logger.warning(f"build_game_state 部分失败: {e}")
        state.rpc_ok = False
    return state.model_dump()

# ─── FastAPI ──────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    await ensure_admin()
    yield
    await bot_manager.stop()
    client.close()

app = FastAPI(title="Penalty Shootout Vault API", lifespan=lifespan)
api = APIRouter(prefix="/api")

# ─── Public Endpoints ─────────────────────────────────────
@api.get("/health")
async def health():
    return {"status": "ok", "ts": int(time.time())}

@api.get("/game/state")
async def get_game_state():
    return await build_game_state()

@api.get("/game/rounds")
async def list_rounds(limit: int = 20, skip: int = 0):
    docs = await col_rounds.find({}, {"_id": 0}).sort([("round_id", -1)]).skip(skip).limit(limit).to_list(length=limit)
    return docs

@api.get("/game/shots")
async def list_shots(limit: int = 30, round_id: Optional[int] = None):
    q = {}
    if round_id is not None:
        q["round_id"] = round_id
    docs = await col_shots.find(q, {"_id": 0}).sort([("timestamp", -1)]).limit(limit).to_list(length=limit)
    return docs

@api.get("/game/config-public")
async def public_config():
    cfg = await get_config()
    # 仅暴露公开字段
    return {
        "chain_id": cfg.chain_id,
        "vault_address": cfg.vault_address,
        "tax_token_address": cfg.tax_token_address,
        "factory_address": cfg.factory_address,
        "configured": bool(cfg.vault_address),
    }

# ─── Admin Endpoints ──────────────────────────────────────
@api.post("/admin/login", response_model=AdminLoginResponse)
async def admin_login(req: AdminLoginRequest):
    doc = await col_admin.find_one({"username": req.username})
    if not doc:
        raise HTTPException(status_code=401, detail="invalid_credentials")
    if not bcrypt.checkpw(req.password.encode(), doc["password_hash"].encode()):
        raise HTTPException(status_code=401, detail="invalid_credentials")
    return create_jwt(req.username)

@api.get("/admin/config")
async def get_admin_config(_=Depends(verify_jwt)):
    cfg = await get_config()
    # 屏蔽私钥本身，但显示是否已配置
    data = cfg.model_dump()
    data["keeper_private_key_set"] = bool(data.pop("keeper_private_key_encrypted", ""))
    return data

@api.put("/admin/config")
async def put_admin_config(patch: VaultConfigUpdate, _=Depends(verify_jwt)):
    cfg = await update_config(patch)
    data = cfg.model_dump()
    data["keeper_private_key_set"] = bool(data.pop("keeper_private_key_encrypted", ""))
    return data

@api.post("/admin/bot/start")
async def start_bot(_=Depends(verify_jwt)):
    await bot_manager.start()
    return {"running": bot_manager.running, "status": bot_manager.status}

@api.post("/admin/bot/stop")
async def stop_bot(_=Depends(verify_jwt)):
    await bot_manager.stop()
    return {"running": bot_manager.running, "status": bot_manager.status}

@api.get("/admin/bot/status")
async def bot_status(_=Depends(verify_jwt)):
    return {
        "running": bot_manager.running,
        "status": bot_manager.status,
        "last_block": bot_manager.last_block,
        "last_error": bot_manager.last_error,
        "recent_buyers": list(bot_manager.last_buyers.keys())[:10],
    }

@api.post("/admin/bot/rewind")
async def rewind_bot(blocks: int = 500, _=Depends(verify_jwt)):
    """让 Bot 回退 N 个 block 重新扫描（不需要重启）"""
    blocks = max(0, min(blocks, 50000))
    bot_manager.last_block = max(0, bot_manager.last_block - blocks)
    await bot_manager.log("info", f"手动回退扫描游标 {blocks} blocks, 新 last_block={bot_manager.last_block}")
    return {"last_block": bot_manager.last_block}

@api.get("/admin/bot/logs")
async def bot_logs(limit: int = 100, _=Depends(verify_jwt)):
    docs = await col_bot_logs.find({}, {"_id": 0}).sort([("timestamp", -1)]).limit(limit).to_list(length=limit)
    return docs

@api.post("/admin/force-shoot")
async def force_shoot(player: Optional[str] = None, _=Depends(verify_jwt)):
    """强制触发一次 shoot：若奖池差额不足 minShotValue，Keeper 自动转 BNB 补足，然后立即 shoot。
    用途：测试游戏流程 / 项目方手动开球 / 跨过 FLAP 税收稀释问题。"""
    cfg = await get_config()
    if not cfg.vault_address or not cfg.keeper_private_key_encrypted:
        raise HTTPException(400, detail="not_configured")
    try:
        w3 = Web3(Web3.HTTPProvider(cfg.rpc_url))
        w3.middleware_onion.inject(ExtraDataToPOAMiddleware, layer=0)
        vault_addr = Web3.to_checksum_address(cfg.vault_address)
        vault = w3.eth.contract(address=vault_addr, abi=VAULT_ABI)

        current_pot = vault.functions.currentPot().call()
        last_mark = vault.functions.lastShotPotMark().call()
        min_shot = vault.functions.minShotValue().call()
        new_amount = current_pot - last_mark

        priv = decrypt_str(cfg.keeper_private_key_encrypted)
        acct = Account.from_key(priv)

        # 默认 player = 最近一个买家；没有就 = keeper 地址
        if player:
            target = Web3.to_checksum_address(player)
        elif bot_manager.last_buyers:
            target = max(bot_manager.last_buyers.items(), key=lambda kv: kv[1])[0]
        else:
            target = acct.address

        result = {"player": target, "new_amount_before": str(new_amount), "min_shot": str(min_shot)}

        # 如果差额不够，先从 keeper 转 BNB 给 vault 补足
        # 佣金最高 6%（税率≤1% 时），所以补 (shortfall / 0.94) + buffer 才稳妥
        if new_amount < min_shot:
            base_shortfall = min_shot - new_amount
            # 留 20% buffer 覆盖佣金 + 安全余量
            shortfall = (base_shortfall * 120) // 100 + 10000
            result["topup_wei"] = str(shortfall)
            tx = {
                "to": vault_addr,
                "value": shortfall,
                "nonce": w3.eth.get_transaction_count(acct.address),
                "gas": 100000,
                "gasPrice": w3.eth.gas_price,
                "chainId": cfg.chain_id,
            }
            signed = acct.sign_transaction(tx)
            txh = w3.eth.send_raw_transaction(signed.raw_transaction)
            result["topup_tx"] = txh.hex() if hasattr(txh, "hex") else str(txh)
            await bot_manager.log("info", f"💰 Keeper 转 {shortfall} wei 给 vault 凑门槛, tx={result['topup_tx']}")
            # 等待 receipt 确认入账
            w3.eth.wait_for_transaction_receipt(txh, timeout=60)

        # 调 shoot
        tx = vault.functions.shoot(target).build_transaction({
            "from": acct.address,
            "nonce": w3.eth.get_transaction_count(acct.address),
            "gas": 1500000,
            "gasPrice": int(w3.eth.gas_price * 1.5),  # 1.5x 加价抢跑 MEV
            "chainId": cfg.chain_id,
        })
        signed = acct.sign_transaction(tx)
        txh = w3.eth.send_raw_transaction(signed.raw_transaction)
        result["shoot_tx"] = txh.hex() if hasattr(txh, "hex") else str(txh)
        await bot_manager.log("info", f"⚽ Force-shoot for {target[:10]}..., tx={result['shoot_tx']}")
        return result
    except Exception as e:
        raise HTTPException(500, detail=f"force-shoot failed: {str(e)[:200]}")


@api.post("/admin/manual-shoot")
async def manual_shoot(player: str, _=Depends(verify_jwt)):
    """管理员手动触发一次 shoot"""
    cfg = await get_config()
    if not cfg.vault_address or not cfg.keeper_private_key_encrypted:
        raise HTTPException(400, detail="not_configured")
    try:
        w3 = Web3(Web3.HTTPProvider(cfg.rpc_url))
        w3.middleware_onion.inject(ExtraDataToPOAMiddleware, layer=0)
        vault = w3.eth.contract(address=Web3.to_checksum_address(cfg.vault_address), abi=VAULT_ABI)
        priv = decrypt_str(cfg.keeper_private_key_encrypted)
        acct = Account.from_key(priv)
        tx = vault.functions.shoot(Web3.to_checksum_address(player)).build_transaction({
            "from": acct.address,
            "nonce": w3.eth.get_transaction_count(acct.address),
            "gas": 1500000,
            "gasPrice": w3.eth.gas_price,
            "chainId": cfg.chain_id,
        })
        signed = acct.sign_transaction(tx)
        txh = w3.eth.send_raw_transaction(signed.raw_transaction)
        await bot_manager.log("info", f"手动 shoot for {player}: tx={txh.hex()}")
        return {"tx_hash": txh.hex()}
    except Exception as e:
        raise HTTPException(500, detail=str(e))

@api.post("/admin/wallet/generate")
async def generate_keeper_wallet(_=Depends(verify_jwt)):
    """生成一个新的 Keeper 钱包并直接存储（私钥加密）"""
    acct = Account.create()
    pk_hex = acct.key.hex()
    if not pk_hex.startswith("0x"):
        pk_hex = "0x" + pk_hex
    patch = VaultConfigUpdate(keeper_private_key=pk_hex)
    cfg = await update_config(patch)
    return {
        "address": cfg.keeper_address,
        "private_key": pk_hex,  # 仅这一次返回，请用户备份
        "warning": "请妥善备份私钥！此私钥不会再次显示。",
    }

# ─── WebSocket ────────────────────────────────────────────
@app.websocket("/api/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    bot_manager.ws_clients.append(ws)
    try:
        # 初始 push 一次完整 state
        state = await build_game_state()
        await ws.send_text(json.dumps({"type": "state", "data": state, "timestamp": int(time.time())}))
        while True:
            await ws.receive_text()  # keepalive
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        try:
            bot_manager.ws_clients.remove(ws)
        except ValueError:
            pass

# ─── App setup ────────────────────────────────────────────
app.include_router(api)
app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get('CORS_ORIGINS', '*').split(','),
    allow_methods=["*"],
    allow_headers=["*"],
)
