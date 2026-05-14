"""
Backend regression tests for Penalty Shootout Vault.

Covers:
- Public endpoints: health, game state, rounds, shots, config-public
- Admin auth: login (success/failure), token gating
- Admin config CRUD + private key encryption + invalid PK
- Keeper wallet generation
- Bot start/stop/status/logs
- WebSocket /api/ws handshake + initial state message
"""
import os
import json
import asyncio
import pytest
import requests
import websockets

BASE_URL = os.environ.get("BACKEND_BASE_URL") or "https://flap-vault-contract.preview.emergentagent.com"
BASE_URL = BASE_URL.rstrip("/")
WS_URL = BASE_URL.replace("https://", "wss://").replace("http://", "ws://") + "/api/ws"

ADMIN_USER = "admin"
ADMIN_PASS = "shootout2026"
# Hardhat known test private key
TEST_PRIV = "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318"
# Derived via eth_account.Account.from_key(TEST_PRIV).address
TEST_PUB_FROM_PRIV = "0x2c7536E3605D9C16a7a3D7b1898e529396a65c23"
TEST_ADDR = "0x000000000000000000000000000000000000bEEF"


@pytest.fixture(scope="session")
def client():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="session")
def admin_token(client):
    r = client.post(f"{BASE_URL}/api/admin/login", json={"username": ADMIN_USER, "password": ADMIN_PASS})
    assert r.status_code == 200, f"Admin login failed: {r.status_code} {r.text}"
    data = r.json()
    assert "token" in data and isinstance(data["token"], str) and len(data["token"]) > 10
    return data["token"]


@pytest.fixture(scope="session")
def auth_client(client, admin_token):
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json", "Authorization": f"Bearer {admin_token}"})
    return s


# ─── Public endpoints ────────────────────────────────────
class TestPublic:
    def test_health(self, client):
        r = client.get(f"{BASE_URL}/api/health")
        assert r.status_code == 200
        d = r.json()
        assert d["status"] == "ok"
        assert "ts" in d and isinstance(d["ts"], int)

    def test_game_state(self, client):
        r = client.get(f"{BASE_URL}/api/game/state")
        assert r.status_code == 200
        d = r.json()
        # configured may be true/false depending on prior test runs
        assert "configured" in d and isinstance(d["configured"], bool)
        for k in ("chain_id", "current_round", "current_pot_wei", "bot_running", "bot_status", "updated_at"):
            assert k in d

    def test_rounds(self, client):
        r = client.get(f"{BASE_URL}/api/game/rounds")
        assert r.status_code == 200
        assert isinstance(r.json(), list)

    def test_shots(self, client):
        r = client.get(f"{BASE_URL}/api/game/shots")
        assert r.status_code == 200
        assert isinstance(r.json(), list)

    def test_config_public(self, client):
        r = client.get(f"{BASE_URL}/api/game/config-public")
        assert r.status_code == 200
        d = r.json()
        for k in ("chain_id", "vault_address", "tax_token_address", "factory_address", "configured"):
            assert k in d


# ─── Admin auth ──────────────────────────────────────────
class TestAdminAuth:
    def test_login_success(self, client):
        r = client.post(f"{BASE_URL}/api/admin/login", json={"username": ADMIN_USER, "password": ADMIN_PASS})
        assert r.status_code == 200
        d = r.json()
        assert "token" in d and "expires_at" in d

    def test_login_invalid(self, client):
        r = client.post(f"{BASE_URL}/api/admin/login", json={"username": ADMIN_USER, "password": "wrongpass"})
        assert r.status_code == 401

    def test_login_unknown_user(self, client):
        r = client.post(f"{BASE_URL}/api/admin/login", json={"username": "nope", "password": "x"})
        assert r.status_code == 401

    def test_config_requires_auth(self, client):
        r = client.get(f"{BASE_URL}/api/admin/config")
        # HTTPBearer returns 403 when missing creds
        assert r.status_code in (401, 403)

    def test_config_with_bad_token(self, client):
        r = requests.get(f"{BASE_URL}/api/admin/config", headers={"Authorization": "Bearer not-a-jwt"})
        assert r.status_code == 401


# ─── Admin config CRUD ───────────────────────────────────
class TestAdminConfig:
    def test_get_config_no_plain_pk(self, auth_client):
        r = auth_client.get(f"{BASE_URL}/api/admin/config")
        assert r.status_code == 200
        d = r.json()
        # Ensure private key is NEVER exposed in plaintext or ciphertext
        assert "keeper_private_key" not in d
        assert "keeper_private_key_encrypted" not in d
        assert "keeper_private_key_set" in d
        assert isinstance(d["keeper_private_key_set"], bool)

    def test_update_basic_fields(self, auth_client):
        patch = {
            "chain_id": 97,
            "rpc_url": "https://data-seed-prebsc-1-s1.binance.org:8545",
            "vault_address": "0x1234567890123456789012345678901234567890",
            "tax_token_address": "0xabcdefABCDEFabcdefABCDEFabcdefABCDEFabcd",
            "poll_interval_seconds": 7,
            "auto_shoot_enabled": False,
        }
        r = auth_client.put(f"{BASE_URL}/api/admin/config", json=patch)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["chain_id"] == 97
        assert d["vault_address"] == patch["vault_address"]
        assert d["tax_token_address"] == patch["tax_token_address"]
        assert d["poll_interval_seconds"] == 7
        assert d["auto_shoot_enabled"] is False
        # Verify GET sees the same
        r2 = auth_client.get(f"{BASE_URL}/api/admin/config")
        d2 = r2.json()
        assert d2["chain_id"] == 97
        assert d2["vault_address"] == patch["vault_address"]

    def test_update_with_valid_private_key(self, auth_client):
        r = auth_client.put(f"{BASE_URL}/api/admin/config", json={"keeper_private_key": TEST_PRIV})
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["keeper_private_key_set"] is True
        assert d["keeper_address"].lower() == TEST_PUB_FROM_PRIV.lower()
        # Private key field never returned
        assert "keeper_private_key" not in d
        assert "keeper_private_key_encrypted" not in d

    def test_update_with_invalid_private_key(self, auth_client):
        r = auth_client.put(f"{BASE_URL}/api/admin/config", json={"keeper_private_key": "not-a-key"})
        assert r.status_code == 400
        assert "invalid_private_key" in r.text


# ─── Wallet generation ───────────────────────────────────
class TestWalletGenerate:
    def test_generate_returns_pk_once(self, auth_client):
        r = auth_client.post(f"{BASE_URL}/api/admin/wallet/generate")
        assert r.status_code == 200, r.text
        d = r.json()
        assert "address" in d and d["address"].startswith("0x") and len(d["address"]) == 42
        assert "private_key" in d and isinstance(d["private_key"], str) and len(d["private_key"]) >= 64
        assert "warning" in d
        # Subsequent GET config should no longer expose pk
        r2 = auth_client.get(f"{BASE_URL}/api/admin/config")
        d2 = r2.json()
        assert d2["keeper_private_key_set"] is True
        assert d2["keeper_address"].lower() == d["address"].lower()
        assert "keeper_private_key" not in d2
        assert "keeper_private_key_encrypted" not in d2


# ─── Bot endpoints ───────────────────────────────────────
class TestBot:
    def test_bot_status(self, auth_client):
        r = auth_client.get(f"{BASE_URL}/api/admin/bot/status")
        assert r.status_code == 200
        d = r.json()
        for k in ("running", "status", "last_block", "last_error"):
            assert k in d

    def test_bot_start_stop(self, auth_client):
        r = auth_client.post(f"{BASE_URL}/api/admin/bot/start")
        assert r.status_code == 200
        d = r.json()
        assert "running" in d and "status" in d
        # status acceptable: running / config_missing / rpc_error (chain unreachable)

        # Give a little time
        import time
        time.sleep(2)

        r2 = auth_client.post(f"{BASE_URL}/api/admin/bot/stop")
        assert r2.status_code == 200
        d2 = r2.json()
        assert d2["running"] is False

    def test_bot_logs(self, auth_client):
        r = auth_client.get(f"{BASE_URL}/api/admin/bot/logs")
        assert r.status_code == 200
        assert isinstance(r.json(), list)


# ─── WebSocket ──────────────────────────────────────────
class TestWebSocket:
    @pytest.mark.asyncio
    async def test_ws_initial_state(self):
        try:
            async with websockets.connect(WS_URL, open_timeout=10, close_timeout=5) as ws:
                msg = await asyncio.wait_for(ws.recv(), timeout=10)
                data = json.loads(msg)
                assert data.get("type") == "state"
                assert "data" in data
                assert "configured" in data["data"]
        except Exception as e:
            pytest.fail(f"WebSocket connection/initial message failed: {e}")
