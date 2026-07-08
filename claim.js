import { ethers } from "https://cdn.jsdelivr.net/npm/ethers@6.13.5/dist/ethers.min.js";

const CLAIM_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function rewardTokenAddress() view returns (address)",
  "function pendingTokenDividend(address) view returns (uint256)",
  "function pendingLPDividend(address) view returns (uint256)",
  "function dividendReserve() view returns (uint256)",
  "function dividendReserveView() view returns (uint256)",
  "function isDividendExcluded(address) view returns (bool)",
  "function isExcludedFromDividends(address) view returns (bool)",
  "function claimDividends()"
];

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)"
];

const BSC_RPC = "https://bsc-dataseed.binance.org";
const BSC_CHAIN_ID = "0x38";
const BSC_PARAMS = {
  chainId: BSC_CHAIN_ID,
  chainName: "BNB Smart Chain",
  nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
  rpcUrls: [BSC_RPC],
  blockExplorerUrls: ["https://bscscan.com"]
};

const state = {
  injected: null,
  provider: null,
  signer: null,
  account: "",
  address: "",
  contract: null,
  rewardSymbol: "BNB",
  rewardDecimals: 18
};

const $ = (id) => document.getElementById(id);
const isAddress = (value) => /^0x[a-fA-F0-9]{40}$/.test(String(value || "").trim());

function walletProvider() {
  const direct = window.okxwallet?.ethereum || window.okxwallet;
  const ethereum = window.ethereum;
  const providers = Array.isArray(ethereum?.providers) ? ethereum.providers : [];
  const candidates = [...providers, direct, ethereum].filter(Boolean);
  return candidates.find((item) => item.isTokenPocket)
    || candidates.find((item) => item.isOkxWallet || item.isOKExWallet)
    || candidates.find((item) => item.isMetaMask)
    || candidates[0]
    || null;
}

function notice(message, type = "") {
  const el = $("notice");
  el.textContent = message;
  el.className = `notice ${type}`.trim();
}

function errorMessage(error) {
  const raw = error?.shortMessage || error?.reason || error?.message || String(error);
  if (/dividend reserve/i.test(raw)) return "分红储备不足，暂时无法领取";
  if (/dividend excluded/i.test(raw)) return "当前钱包已被排除分红";
  if (/user rejected|ACTION_REJECTED|denied transaction/i.test(raw)) return "已取消钱包确认";
  if (/insufficient funds|gas \* price|overshot/i.test(raw)) return "钱包 BNB 不足，无法支付 Gas 手续费";
  return raw;
}

function format(value) {
  const text = ethers.formatUnits(value, state.rewardDecimals);
  if (!text.includes(".")) return text;
  const [whole, fraction] = text.split(".");
  const trimmed = fraction.slice(0, 12).replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : whole;
}

function shorten(address) {
  return address ? `${address.slice(0, 7)}...${address.slice(-5)}` : "未连接";
}

function readAddress() {
  const queryAddress = new URLSearchParams(location.search).get("contract") || "";
  const inputAddress = $("contractAddress").value.trim();
  const storedAddress = localStorage.getItem("dividendClaimContract") || "";
  const address = queryAddress || inputAddress || storedAddress;
  if (!isAddress(address)) {
    $("contractSetup").hidden = false;
    throw new Error("请填写正确的分红合约地址");
  }
  state.address = ethers.getAddress(address);
  $("contractAddress").value = state.address;
  $("contractSetup").hidden = Boolean(queryAddress);
  localStorage.setItem("dividendClaimContract", state.address);
  return state.address;
}

async function switchBsc(provider) {
  const chainId = await provider.request({ method: "eth_chainId" }).catch(() => "");
  if (String(chainId).toLowerCase() === BSC_CHAIN_ID) return;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: BSC_CHAIN_ID }] });
  } catch (error) {
    if (error?.code !== 4902 && !/not added|unrecognized/i.test(error?.message || "")) throw error;
    await provider.request({ method: "wallet_addEthereumChain", params: [BSC_PARAMS] });
  }
}

async function connectWallet(requestAccounts = true) {
  const injected = walletProvider();
  if (!injected?.request) throw new Error("没有检测到钱包，请在 MetaMask、TP 或欧易 Web3 钱包中打开");
  if (requestAccounts) await injected.request({ method: "eth_requestAccounts" });
  await switchBsc(injected);
  state.injected = injected;
  state.provider = new ethers.BrowserProvider(injected);
  state.signer = await state.provider.getSigner();
  state.account = await state.signer.getAddress();
  $("walletAddress").textContent = shorten(state.account);
  $("connectWallet").textContent = "已连接";
  $("connectWallet").classList.add("connected");
  $("connectWallet").disabled = true;
  $("networkName").textContent = "BNB Smart Chain";
  await loadContract();
}

async function rewardInfo(contract) {
  const rewardAddress = await contract.rewardTokenAddress().catch(() => ethers.ZeroAddress);
  if (rewardAddress === ethers.ZeroAddress) return { symbol: "BNB", decimals: 18 };
  const reward = new ethers.Contract(rewardAddress, ERC20_ABI, state.signer || state.provider);
  return {
    symbol: await reward.symbol().catch(() => "TOKEN"),
    decimals: Number(await reward.decimals().catch(() => 18))
  };
}

async function loadContract() {
  const address = readAddress();
  if (!state.provider) state.provider = new ethers.JsonRpcProvider(BSC_RPC);
  state.contract = new ethers.Contract(address, CLAIM_ABI, state.signer || state.provider);
  const [name, symbol, reward] = await Promise.all([
    state.contract.name(),
    state.contract.symbol(),
    rewardInfo(state.contract)
  ]);
  state.rewardSymbol = reward.symbol;
  state.rewardDecimals = reward.decimals;
  $("tokenName").textContent = name;
  $("tokenSymbol").textContent = symbol;
  $("rewardSymbol").textContent = `${reward.symbol} 分红`;
  $("totalPending").textContent = `0 ${reward.symbol}`;
  $("tokenPending").textContent = `0 ${reward.symbol}`;
  $("lpPending").textContent = `0 ${reward.symbol}`;
  await refreshRewards();
}

async function refreshRewards() {
  if (!state.contract) return;
  const reserve = await state.contract.dividendReserveView().catch(() => state.contract.dividendReserve());
  $("dividendReserve").textContent = `${format(reserve)} ${state.rewardSymbol}`;
  if (!state.account) {
    $("claimDividends").disabled = true;
    return;
  }
  const [tokenPending, lpPending, excluded] = await Promise.all([
    state.contract.pendingTokenDividend(state.account),
    state.contract.pendingLPDividend(state.account),
    state.contract.isDividendExcluded(state.account).catch(() => state.contract.isExcludedFromDividends(state.account))
  ]);
  const total = tokenPending + lpPending;
  $("tokenPending").textContent = `${format(tokenPending)} ${state.rewardSymbol}`;
  $("lpPending").textContent = `${format(lpPending)} ${state.rewardSymbol}`;
  $("totalPending").textContent = `${format(total)} ${state.rewardSymbol}`;
  $("eligibility").textContent = excluded ? "当前钱包已被排除分红" : "分红已按当前钱包权益计算";
  $("claimDividends").disabled = excluded || total === 0n;
}

async function claim() {
  if (!state.signer) await connectWallet(true);
  state.contract = new ethers.Contract(state.address || readAddress(), CLAIM_ABI, state.signer);
  const [pendingToken, pendingLP, reserve] = await Promise.all([
    state.contract.pendingTokenDividend(state.account),
    state.contract.pendingLPDividend(state.account),
    state.contract.dividendReserveView().catch(() => state.contract.dividendReserve())
  ]);
  const total = pendingToken + pendingLP;
  if (total === 0n) throw new Error("当前钱包没有可领取分红");
  if (reserve < total) throw new Error("分红储备不足，暂时无法领取");
  notice("请在钱包中确认领取交易");
  const tx = await state.contract.claimDividends();
  notice("交易已提交，等待链上确认");
  await tx.wait();
  notice("分红领取成功", "ok");
  await refreshRewards();
}

async function run(button, task) {
  try {
    button.disabled = true;
    notice("");
    await task();
  } catch (error) {
    console.error(error);
    notice(errorMessage(error), "error");
  } finally {
    if (button.id === "claimDividends") {
      await refreshRewards().catch(() => { button.disabled = false; });
    } else if (!button.classList.contains("connected")) {
      button.disabled = false;
    }
  }
}

function boot() {
  $("connectWallet").addEventListener("click", (event) => run(event.currentTarget, () => connectWallet(true)));
  $("switchNetwork").addEventListener("click", (event) => run(event.currentTarget, async () => {
    const provider = walletProvider();
    if (!provider) throw new Error("没有检测到钱包");
    await switchBsc(provider);
    if (state.account) await connectWallet(false);
  }));
  $("loadContract").addEventListener("click", (event) => run(event.currentTarget, loadContract));
  $("claimDividends").addEventListener("click", (event) => run(event.currentTarget, claim));

  try {
    readAddress();
    loadContract().catch((error) => notice(errorMessage(error), "error"));
  } catch (error) {
    notice(errorMessage(error), "error");
  }

  const injected = walletProvider();
  injected?.request?.({ method: "eth_accounts" }).then((accounts) => {
    if (accounts?.length) connectWallet(false).catch(() => {});
  }).catch(() => {});
}

boot();
