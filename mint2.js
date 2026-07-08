import { ethers } from "https://cdn.jsdelivr.net/npm/ethers@6.13.5/dist/ethers.min.js";

const TOKEN_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function mintMode() view returns (uint8)",
  "function usdtAddress() view returns (address)",
  "function rewardTokenAddress() view returns (address)",
  "function mintPrice() view returns (uint256)",
  "function tokenPerMint() view returns (uint256)",
  "function mintedCount() view returns (uint256)",
  "function maxMintCount() view returns (uint256)",
  "function mintEnabled() view returns (bool)",
  "function hasMinted(address) view returns (bool)",
  "function whitelistEnabled() view returns (bool)",
  "function whitelist(address) view returns (bool)",
  "function pendingTokenDividend(address) view returns (uint256)",
  "function pendingLPDividend(address) view returns (uint256)",
  "function dividendReserveView() view returns (uint256)",
  "function minTokenDividendBalanceView() view returns (uint256)",
  "function mintBNB() payable",
  "function mintUSDT()",
  "function claimDividends()"
];

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)"
];

const NETWORKS = {
  56: { name: "BNB Smart Chain", native: "BNB" },
  97: { name: "BNB Smart Chain Testnet", native: "tBNB" }
};

const BSC_RPC = "https://bsc-dataseed.binance.org";
const BSC_CHAIN_ID_HEX = "0x38";
const BSC_CHAIN_PARAMS = {
  chainId: BSC_CHAIN_ID_HEX,
  chainName: "BNB Smart Chain",
  nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
  rpcUrls: [BSC_RPC],
  blockExplorerUrls: ["https://bscscan.com"]
};

const TEXT = {
  connect: "\u8fde\u63a5\u94b1\u5305",
  connected: "\u5df2\u8fde\u63a5",
  disconnected: "\u672a\u8fde\u63a5",
  unknown: "\u672a\u77e5",
  mintPrice: "Mint \u4ef7\u683c",
  mintProgress: "Mint \u8fdb\u5ea6",
  mintStatus: "Mint \u72b6\u6001",
  qualification: "\u6211\u7684\u8d44\u683c",
  enabled: "\u5f00\u542f",
  disabled: "\u5173\u95ed",
  minted: "\u5df2 Mint",
  notMinted: "\u672a Mint",
  whitelistOk: "\u5df2\u5728\u767d\u540d\u5355",
  whitelistNo: "\u672a\u5728\u767d\u540d\u5355",
  connectFirst: "\u8fde\u63a5\u540e\u663e\u793a",
  tokenReward: "\u6301\u5e01\u53ef\u9886",
  mintComplete: "Mint \u5df2\u5b8c\u6210\uff0c\u8bf7\u5173\u6ce8\u5f00\u76d8",
  bnbNotEnough: "BNB \u94b1\u5305 BNB \u4e0d\u8db3\uff0c\u8bf7\u9884\u7559 Mint \u91d1\u989d\u548c Gas \u624b\u7eed\u8d39",
  switchBsc: "\u8bf7\u5c06\u94b1\u5305\u7f51\u7edc\u5207\u6362\u5230 BNB Smart Chain",
  readContract: "\u8bf7\u5728\u94fe\u63a5\u4e2d\u5e26\u4e0a contract \u5408\u7ea6\u5730\u5740",
  badWallet: "\u6ca1\u6709\u68c0\u6d4b\u5230\u94b1\u5305\uff0c\u8bf7\u5728 MetaMask \u6216 TP \u94b1\u5305\u5185\u6253\u5f00\u3002"
};

const state = {
  provider: null,
  signer: null,
  account: "",
  contract: null,
  contractAddress: "",
  tokenDecimals: 18,
  rewardDecimals: 18,
  rewardSymbol: "BNB",
  mintPaySymbol: "BNB",
  mintPayDecimals: 18,
  nativeSymbol: "BNB"
};

const $ = (id) => document.getElementById(id);
const isAddress = (value) => /^0x[a-fA-F0-9]{40}$/.test(String(value || "").trim());

function injectedProvider() {
  const eth = window.ethereum;
  if (!eth) throw new Error(TEXT.badWallet);
  if (Array.isArray(eth.providers)) {
    return eth.providers.find((provider) => provider.isTokenPocket)
      || eth.providers.find((provider) => provider.isMetaMask)
      || eth.providers[0];
  }
  return eth;
}

function setBusy(button, busy) {
  if (!button || button.classList.contains("connected")) return;
  button.disabled = busy;
}

function log(message) {
  const box = $("log");
  if (box) box.textContent = `[${new Date().toLocaleTimeString()}] ${message}\n` + box.textContent;
}

function showError(error) {
  const raw = error?.shortMessage || error?.reason || error?.message || String(error);
  const message = /insufficient funds|exceeds balance|not enough|gas \* price|overshot/i.test(raw)
    ? TEXT.bnbNotEnough
    : raw;
  log(message);
  alert(message);
}

function formatAmount(value, decimals = 18, max = 6) {
  const text = ethers.formatUnits(value, decimals);
  if (!text.includes(".")) return text;
  const [whole, frac] = text.split(".");
  const trimmed = frac.slice(0, max).replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : whole;
}

function displayTokenName(name) {
  return String(name || "Mint Portal")
    .replace(/（[\s\S]*$/g, "")
    .replace(/\([\s\S]*$/g, "")
    .replace(/（[^）]*）/g, "")
    .replace(/\([^)]*\)/g, "")
    .trim() || "Mint Portal";
}

function renderStats(id, items) {
  const el = $(id);
  if (!el) return;
  el.innerHTML = items.map(([label, value]) => (
    `<div class="stat"><span>${label}</span><strong>${value}</strong></div>`
  )).join("");
}

function markConnected() {
  $("walletAddress").textContent = state.account;
  $("connectWallet").textContent = TEXT.connected;
  $("connectWallet").classList.add("connected");
  $("connectWallet").disabled = true;
}

async function finishWallet(provider) {
  state.provider = new ethers.BrowserProvider(provider);
  state.signer = await state.provider.getSigner();
  state.account = await state.signer.getAddress();
  const network = await state.provider.getNetwork();
  const chainId = Number(network.chainId);
  state.nativeSymbol = NETWORKS[chainId]?.native || "BNB";
  $("networkName").textContent = NETWORKS[chainId]?.name || `Chain ${chainId}`;
  markConnected();
  await loadContract();
}

async function ensureBscNetwork(provider) {
  if (!provider?.request) return;
  const currentChainId = await provider.request({ method: "eth_chainId" }).catch(() => "");
  if (String(currentChainId).toLowerCase() === BSC_CHAIN_ID_HEX) return;
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: BSC_CHAIN_ID_HEX }]
    });
  } catch (error) {
    if (error?.code === 4902 || /Unrecognized|not added|wallet_addEthereumChain/i.test(error?.message || "")) {
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [BSC_CHAIN_PARAMS]
      });
      return;
    }
    throw new Error(TEXT.switchBsc);
  }
}

async function connectWallet() {
  const provider = injectedProvider();
  await provider.request({ method: "eth_requestAccounts" });
  await ensureBscNetwork(provider);
  await finishWallet(provider);
}

async function switchNetwork() {
  const provider = injectedProvider();
  await ensureBscNetwork(provider);
  $("networkName").textContent = NETWORKS[56].name;
  if (state.signer) await finishWallet(provider);
}

async function trySilentConnect() {
  const provider = window.ethereum ? injectedProvider() : null;
  if (!provider?.request) return;
  const accounts = await provider.request({ method: "eth_accounts" }).catch(() => []);
  if (!accounts?.length) return;
  await finishWallet(provider);
}

async function ensureWallet() {
  if (!state.signer) await connectWallet();
  else await ensureBscNetwork(injectedProvider());
}

function readContractAddress() {
  const params = new URLSearchParams(location.search);
  const address = params.get("contract") || localStorage.getItem("modaMintContract") || "";
  if (!isAddress(address)) throw new Error(TEXT.readContract);
  state.contractAddress = address;
  $("contractAddress").value = address;
  localStorage.setItem("modaMintContract", address);
  return address;
}

async function loadContract() {
  readContractAddress();
  if (!state.provider) {
    if (window.ethereum) state.provider = new ethers.BrowserProvider(injectedProvider());
    else state.provider = new ethers.JsonRpcProvider(BSC_RPC);
  }
  state.contract = new ethers.Contract(state.contractAddress, TOKEN_ABI, state.signer || state.provider);
  await refreshContract();
}

async function refreshContract() {
  if (!state.contract) return;
  const [
    name,
    symbol,
    decimals,
    mode,
    mintPrice,
    mintedCount,
    maxMintCount,
    mintEnabled
  ] = await Promise.all([
    state.contract.name(),
    state.contract.symbol(),
    state.contract.decimals(),
    state.contract.mintMode(),
    state.contract.mintPrice(),
    state.contract.mintedCount(),
    state.contract.maxMintCount(),
    state.contract.mintEnabled()
  ]);

  state.tokenDecimals = Number(decimals);
  state.mintPaySymbol = Number(mode) === 0 ? state.nativeSymbol : "USDT";
  state.mintPayDecimals = 18;
  state.rewardSymbol = state.mintPaySymbol;
  state.rewardDecimals = 18;

  let qualification = TEXT.connectFirst;
  let pendingToken = 0n;
  if (state.account) {
    const [hasMinted, whitelistEnabled, userPendingToken] = await Promise.all([
      state.contract.hasMinted(state.account),
      state.contract.whitelistEnabled(),
      state.contract.pendingTokenDividend(state.account)
    ]);
    qualification = hasMinted ? TEXT.minted : TEXT.notMinted;
    if (whitelistEnabled && !hasMinted) {
      qualification = await state.contract.whitelist(state.account) ? TEXT.whitelistOk : TEXT.whitelistNo;
    }
    pendingToken = userPendingToken;
  }

  if (Number(mode) === 1) {
    const usdt = await state.contract.usdtAddress();
    const payToken = new ethers.Contract(usdt, ERC20_ABI, state.signer || state.provider);
    state.mintPaySymbol = await payToken.symbol().catch(() => "USDT");
    state.mintPayDecimals = Number(await payToken.decimals().catch(() => 18));
    state.rewardSymbol = state.mintPaySymbol;
    state.rewardDecimals = state.mintPayDecimals;
  }

  const rewardAddress = await state.contract.rewardTokenAddress().catch(() => ethers.ZeroAddress);
  if (rewardAddress !== ethers.ZeroAddress) {
    const reward = new ethers.Contract(rewardAddress, ERC20_ABI, state.signer || state.provider);
    state.rewardSymbol = await reward.symbol().catch(() => "TOKEN");
    state.rewardDecimals = Number(await reward.decimals().catch(() => 18));
  }

  $("tokenTitle").textContent = displayTokenName(name);
  $("mintModeBadge").textContent = Number(mode) === 0 ? "BNB" : "USDT";
  $("rewardUnitBadge").textContent = state.rewardSymbol;

  renderStats("mintStats", [
    [TEXT.mintPrice, `${formatAmount(mintPrice, state.mintPayDecimals)} ${state.mintPaySymbol}`],
    ["Hidden token per mint", ""],
    [TEXT.mintProgress, `${mintedCount.toString()} / ${maxMintCount.toString()}`],
    [TEXT.mintStatus, mintEnabled ? TEXT.enabled : TEXT.disabled],
    ["Hidden balance", ""],
    [TEXT.qualification, qualification]
  ]);

  renderStats("rewardStats", [
    [TEXT.tokenReward, `${formatAmount(pendingToken, state.rewardDecimals)} ${state.rewardSymbol}`]
  ]);
}

async function approveIfNeeded(tokenAddress, spender, amount) {
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, state.signer);
  const allowance = await token.allowance(state.account, spender);
  if (allowance >= amount) return;
  const tx = await token.approve(spender, amount);
  await tx.wait();
}

async function ensureMintAvailable() {
  if (!state.contract) await loadContract();
  const [mintedCount, maxMintCount, mintEnabled] = await Promise.all([
    state.contract.mintedCount(),
    state.contract.maxMintCount(),
    state.contract.mintEnabled()
  ]);
  if (!mintEnabled || mintedCount >= maxMintCount) {
    alert(TEXT.mintComplete);
    log(TEXT.mintComplete);
    return false;
  }
  return true;
}

async function mintNow() {
  await ensureWallet();
  state.contract = new ethers.Contract(state.contractAddress || readContractAddress(), TOKEN_ABI, state.signer);
  const mode = Number(await state.contract.mintMode());
  const price = await state.contract.mintPrice();
  let tx;
  if (mode === 0) {
    tx = await state.contract.mintBNB({ value: price });
  } else {
    const usdt = await state.contract.usdtAddress();
    const token = new ethers.Contract(usdt, ERC20_ABI, state.signer);
    const balance = await token.balanceOf(state.account);
    if (balance < price) throw new Error("USDT balance is not enough.");
    await approveIfNeeded(usdt, state.contractAddress, price);
    tx = await state.contract.mintUSDT();
  }
  await tx.wait();
  await refreshContract();
}

async function claimDividends() {
  await ensureWallet();
  if (!state.contract) await loadContract();
  const tx = await state.contract.claimDividends();
  await tx.wait();
  await refreshContract();
}

async function run(button, fn) {
  try {
    setBusy(button, true);
    await fn();
  } catch (error) {
    console.error(error);
    showError(error);
  } finally {
    setBusy(button, false);
  }
}

function boot() {
  try {
    readContractAddress();
    loadContract().catch((error) => log(error.shortMessage || error.message || String(error)));
  } catch (error) {
    log(error.message || String(error));
  }
  $("connectWallet").addEventListener("click", (event) => run(event.currentTarget, connectWallet));
  $("switchNetwork").addEventListener("click", (event) => run(event.currentTarget, switchNetwork));
  $("mintNow").addEventListener("click", (event) => run(event.currentTarget, mintNow));
  $("claimDividends").addEventListener("click", (event) => run(event.currentTarget, claimDividends));
  $("loadContract")?.addEventListener("click", (event) => run(event.currentTarget, loadContract));
  trySilentConnect().catch(() => {});
}

boot();
