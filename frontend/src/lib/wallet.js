import { BrowserProvider, Contract, parseEther } from "ethers";

const BSC_MAINNET = {
  chainId: "0x38", // 56
  chainName: "BNB Smart Chain",
  nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
  rpcUrls: ["https://bsc-rpc.publicnode.com"],
  blockExplorerUrls: ["https://bscscan.com"],
};

const BSC_TESTNET = {
  chainId: "0x61", // 97
  chainName: "BNB Smart Chain Testnet",
  nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 },
  rpcUrls: ["https://data-seed-prebsc-1-s1.binance.org:8545"],
  blockExplorerUrls: ["https://testnet.bscscan.com"],
};

export const VAULT_ABI = [
  "function shoot(address player) external",
  "function buyAndShoot(uint256 minTokenOut) external payable",
  "function settleRound() external",
  "function currentPot() view returns (uint256)",
  "function minShotValue() view returns (uint256)",
];

export async function connectWallet(targetChainId) {
  if (!window.ethereum) {
    throw new Error("未检测到钱包 / No wallet detected. Please install MetaMask.");
  }
  const provider = new BrowserProvider(window.ethereum);
  await window.ethereum.request({ method: "eth_requestAccounts" });
  const network = await provider.getNetwork();
  const currentChainId = Number(network.chainId);

  if (targetChainId && currentChainId !== targetChainId) {
    await switchChain(targetChainId);
  }

  const signer = await provider.getSigner();
  const address = await signer.getAddress();
  return { provider, signer, address, chainId: targetChainId || currentChainId };
}

export async function switchChain(chainId) {
  const cfg = chainId === 56 ? BSC_MAINNET : BSC_TESTNET;
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: cfg.chainId }],
    });
  } catch (e) {
    // 4902 = chain not added
    if (e.code === 4902 || (e.data && e.data.originalError && e.data.originalError.code === 4902)) {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [cfg],
      });
    } else {
      throw e;
    }
  }
}

export async function buyAndShoot({ signer, vaultAddress, bnbAmount }) {
  const vault = new Contract(vaultAddress, VAULT_ABI, signer);
  const tx = await vault.buyAndShoot(0, {
    value: parseEther(String(bnbAmount)),
  });
  return tx;
}

export async function shoot({ signer, vaultAddress, playerAddress }) {
  const vault = new Contract(vaultAddress, VAULT_ABI, signer);
  const tx = await vault.shoot(playerAddress);
  return tx;
}

export async function settleRound({ signer, vaultAddress }) {
  const vault = new Contract(vaultAddress, VAULT_ABI, signer);
  const tx = await vault.settleRound();
  return tx;
}

export function listenAccountChanges(onAccountChange, onChainChange) {
  if (!window.ethereum) return;
  window.ethereum.on("accountsChanged", onAccountChange);
  window.ethereum.on("chainChanged", onChainChange);
}
