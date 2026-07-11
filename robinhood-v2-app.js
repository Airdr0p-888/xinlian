import { ethers } from "https://cdn.jsdelivr.net/npm/ethers@6.13.5/dist/ethers.min.js";

const SOURCE = String.raw`// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IUniswapV2Router02 {
    function factory() external pure returns (address);
    function WETH() external pure returns (address);
    function addLiquidityETH(
        address token,
        uint amountTokenDesired,
        uint amountTokenMin,
        uint amountETHMin,
        address to,
        uint deadline
    ) external payable returns (uint amountToken, uint amountETH, uint liquidity);
}

interface IUniswapV2Factory {
    function getPair(address tokenA, address tokenB) external view returns (address pair);
    function createPair(address tokenA, address tokenB) external returns (address pair);
}

contract RobinhoodV2AutoLiquidityMint is ERC20, Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    uint256 private constant MAGNITUDE = 2 ** 128;
    uint256 private constant BP_DENOMINATOR = 10000;
    address public constant ROUTER = 0x89e5DB8B5aA49aA85AC63f691524311AEB649eba;
    address public constant FACTORY = 0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f;
    address public constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;

    uint256 public mintPrice;
    uint256 public userTokenPerMint;
    uint256 public liquidityTokenPerMint;
    uint256 public liquidityEthBP;
    uint256 public maxMintCount;
    uint256 public maxMintPerWallet;
    uint256 public mintedCount;
    bool public mintEnabled = true;
    bool public mintWhitelistEnabled;
    address public lpReceiver;
    uint8 public lpReceiverMode;
    mapping(address => uint256) public walletMintCount;
    mapping(address => bool) public mintWhitelist;

    bool public tradingOpen;
    uint256 public launchTime;
    bool public preLaunchWhitelistEnabled;
    mapping(address => bool) public preLaunchWhitelist;
    mapping(address => bool) public preLaunchBuyOnlyWhitelist;
    mapping(address => bool) public automatedMarketMakerPairs;
    mapping(address => bool) public blacklist;
    mapping(address => bool) public transferWhitelist;
    uint256 public buyTaxBP;
    uint256 public sellTaxBP;
    address public taxWallet;
    uint256 public maxBuyAmount;
    uint256 public maxWalletAmount;

    uint256 public magnifiedDividendPerShare;
    uint256 public dividendReserve;
    uint256 public totalDividendsDistributed;
    uint256 public excludedDividendSupply;
    mapping(address => int256) private magnifiedDividendCorrections;
    mapping(address => uint256) public withdrawnDividends;
    mapping(address => bool) public dividendExcluded;

    event Minted(address indexed user, uint256 indexed number, uint256 userTokens, uint256 liquidityTokensDesired, uint256 liquidityETHDesired, uint256 paidETH);
    event AutoLiquidity(uint256 tokenAmount, uint256 ethAmount, uint256 liquidity, address indexed pair);
    event PairSet(address indexed pair, bool enabled);
    event DividendsFunded(address indexed sender, uint256 amount);
    event DividendClaimed(address indexed user, uint256 amount);

    constructor(
        string memory name_, string memory symbol_, uint256 supply_, address owner_, address taxWallet_, address lpReceiver_, uint8 lpReceiverMode_,
        uint256 mintPrice_, uint256 userTokenPerMint_, uint256 liquidityTokenPerMint_, uint256 liquidityEthBP_,
        uint256 maxMintCount_, uint256 maxMintPerWallet_, bool mintWhitelistEnabled_,
        uint256 launchTime_, bool preLaunchWhitelistEnabled_, uint256 buyTaxBP_, uint256 sellTaxBP_, uint256 maxBuyAmount_, uint256 maxWalletAmount_
    ) ERC20(name_, symbol_) Ownable(owner_) {
        require(supply_ > 0 && userTokenPerMint_ > 0, "zero config");
        require(taxWallet_ != address(0) && lpReceiver_ != address(0), "zero wallet");
        require(lpReceiverMode_ <= 1, "bad lp mode");
        require(maxMintCount_ > 0 && maxMintPerWallet_ > 0, "bad mint limit");
        require(liquidityEthBP_ <= BP_DENOMINATOR, "lp eth > 100%");
        require((userTokenPerMint_ + liquidityTokenPerMint_) * maxMintCount_ <= supply_, "mint plan exceeds supply");
        require(buyTaxBP_ <= 2000 && sellTaxBP_ <= 2000, "tax > 20%");
        require(IUniswapV2Router02(ROUTER).factory() == FACTORY && IUniswapV2Router02(ROUTER).WETH() == WETH, "bad router");

        mintPrice = mintPrice_; userTokenPerMint = userTokenPerMint_; liquidityTokenPerMint = liquidityTokenPerMint_; liquidityEthBP = liquidityEthBP_;
        maxMintCount = maxMintCount_; maxMintPerWallet = maxMintPerWallet_; mintWhitelistEnabled = mintWhitelistEnabled_;
        launchTime = launchTime_; preLaunchWhitelistEnabled = preLaunchWhitelistEnabled_;
        buyTaxBP = buyTaxBP_; sellTaxBP = sellTaxBP_; taxWallet = taxWallet_; lpReceiver = lpReceiver_; lpReceiverMode = lpReceiverMode_;
        maxBuyAmount = maxBuyAmount_; maxWalletAmount = maxWalletAmount_;

        transferWhitelist[owner_] = true; transferWhitelist[address(this)] = true; transferWhitelist[ROUTER] = true; transferWhitelist[taxWallet_] = true;
        preLaunchWhitelist[owner_] = true; preLaunchWhitelist[address(this)] = true; preLaunchWhitelist[ROUTER] = true;
        dividendExcluded[address(this)] = true; dividendExcluded[taxWallet_] = true;
        _mint(address(this), supply_);

        address pair = IUniswapV2Factory(FACTORY).getPair(address(this), WETH);
        if (pair != address(0)) _setPair(pair, true);
    }

    receive() external payable {}

    function mint() external payable nonReentrant whenNotPaused {
        require(mintEnabled, "mint disabled");
        require(msg.value == mintPrice, "bad ETH amount");
        require(mintedCount < maxMintCount, "mint full");
        require(walletMintCount[msg.sender] < maxMintPerWallet, "wallet mint limit");
        if (mintWhitelistEnabled) require(mintWhitelist[msg.sender], "not mint whitelist");

        uint256 tokenNeed = userTokenPerMint + liquidityTokenPerMint;
        require(balanceOf(address(this)) >= tokenNeed, "insufficient token reserve");
        unchecked { mintedCount++; walletMintCount[msg.sender]++; }

        _transfer(address(this), msg.sender, userTokenPerMint);

        uint256 ethForLiquidity = msg.value * liquidityEthBP / BP_DENOMINATOR;
        if (ethForLiquidity > 0 && liquidityTokenPerMint > 0) {
            _approve(address(this), ROUTER, liquidityTokenPerMint);
            address receiver = lpReceiverMode == 1 ? msg.sender : lpReceiver;
            (uint256 tokenUsed, uint256 ethUsed, uint256 liquidity) = IUniswapV2Router02(ROUTER).addLiquidityETH{value: ethForLiquidity}(
                address(this), liquidityTokenPerMint, 0, 0, receiver, block.timestamp + 600
            );
            address pair = IUniswapV2Factory(FACTORY).getPair(address(this), WETH);
            if (pair != address(0) && !automatedMarketMakerPairs[pair]) _setPair(pair, true);
            emit AutoLiquidity(tokenUsed, ethUsed, liquidity, pair);
        }
        emit Minted(msg.sender, mintedCount, userTokenPerMint, liquidityTokenPerMint, ethForLiquidity, msg.value);
    }

    function createPairIfNeeded() external onlyOwner returns (address pair) {
        pair = IUniswapV2Factory(FACTORY).getPair(address(this), WETH);
        if (pair == address(0)) pair = IUniswapV2Factory(FACTORY).createPair(address(this), WETH);
        _setPair(pair, true);
    }

    function _update(address from, address to, uint256 amount) internal override {
        if (from == address(0) || to == address(0)) { _move(from, to, amount); return; }
        require(!paused(), "paused");
        require(!blacklist[from] && !blacklist[to], "blacklisted");
        bool buy = automatedMarketMakerPairs[from]; bool sell = automatedMarketMakerPairs[to];
        if (buy || sell) {
            if (!tradingOpen && (launchTime == 0 || block.timestamp < launchTime)) {
                if (preLaunchWhitelistEnabled) {
                    if (buy) require(preLaunchWhitelist[to] || preLaunchBuyOnlyWhitelist[to], "buy not allowed");
                    else require(preLaunchWhitelist[from], "sell not allowed before open");
                }
            }
        }
        uint256 tax;
        if (!transferWhitelist[from] && !transferWhitelist[to]) {
            if (buy) tax = amount * buyTaxBP / BP_DENOMINATOR;
            else if (sell) tax = amount * sellTaxBP / BP_DENOMINATOR;
        }
        uint256 received = amount - tax;
        if (buy && maxBuyAmount > 0) require(received <= maxBuyAmount, "max buy");
        if (buy && maxWalletAmount > 0 && !transferWhitelist[to]) require(balanceOf(to) + received <= maxWalletAmount, "max wallet");
        _move(from, to, received);
        if (tax > 0) _move(from, taxWallet, tax);
    }

    function _move(address from, address to, uint256 amount) private {
        super._update(from, to, amount);
        if (from != address(0) && dividendExcluded[from]) excludedDividendSupply -= amount;
        if (to != address(0) && dividendExcluded[to]) excludedDividendSupply += amount;
        int256 correction = int256(magnifiedDividendPerShare * amount);
        if (from != address(0) && !dividendExcluded[from]) magnifiedDividendCorrections[from] += correction;
        if (to != address(0) && !dividendExcluded[to]) magnifiedDividendCorrections[to] -= correction;
    }

    function eligibleDividendSupply() public view returns (uint256 value) { value = totalSupply() - excludedDividendSupply; }
    function fundDividends() external payable nonReentrant {
        require(msg.value > 0, "zero dividend");
        uint256 supply = eligibleDividendSupply(); require(supply > 0, "no eligible holders");
        magnifiedDividendPerShare += msg.value * MAGNITUDE / supply;
        dividendReserve += msg.value; totalDividendsDistributed += msg.value;
        emit DividendsFunded(msg.sender, msg.value);
    }
    function accumulativeDividendOf(address user) public view returns (uint256) {
        if (dividendExcluded[user]) return withdrawnDividends[user];
        int256 value = int256(magnifiedDividendPerShare * balanceOf(user)) + magnifiedDividendCorrections[user];
        return value <= 0 ? 0 : uint256(value) / MAGNITUDE;
    }
    function withdrawableDividendOf(address user) public view returns (uint256) {
        uint256 total = accumulativeDividendOf(user); return total > withdrawnDividends[user] ? total - withdrawnDividends[user] : 0;
    }
    function claimDividends() external nonReentrant {
        uint256 amount = withdrawableDividendOf(msg.sender); require(amount > 0, "no dividend");
        withdrawnDividends[msg.sender] += amount; dividendReserve -= amount;
        (bool ok,) = payable(msg.sender).call{value: amount}(""); require(ok, "ETH transfer failed");
        emit DividendClaimed(msg.sender, amount);
    }

    function setMintConfig(uint256 price, uint256 userTokens, uint256 liquidityTokens, uint256 ethBP, uint256 maxCount, uint256 perWallet) external onlyOwner {
        require(userTokens > 0 && maxCount >= mintedCount && perWallet > 0, "bad config");
        require(ethBP <= BP_DENOMINATOR, "lp eth > 100%");
        require((userTokens + liquidityTokens) * maxCount <= totalSupply(), "plan exceeds supply");
        mintPrice = price; userTokenPerMint = userTokens; liquidityTokenPerMint = liquidityTokens; liquidityEthBP = ethBP; maxMintCount = maxCount; maxMintPerWallet = perWallet;
    }
    function setMintEnabled(bool value) external onlyOwner { mintEnabled = value; }
    function setMintWhitelistEnabled(bool value) external onlyOwner { mintWhitelistEnabled = value; }
    function setMintWhitelist(address user, bool value) external onlyOwner { mintWhitelist[user] = value; }
    function setMintWhitelistBatch(address[] calldata users, bool value) external onlyOwner {
        for (uint256 i = 0; i < users.length; i++) {
            mintWhitelist[users[i]] = value;
        }
    }
    function setBlacklist(address user, bool value) external onlyOwner { blacklist[user] = value; }
    function setTransferWhitelist(address user, bool value) external onlyOwner { transferWhitelist[user] = value; }
    function setPreLaunchWhitelist(address user, bool value) external onlyOwner { preLaunchWhitelist[user] = value; }
    function setPreLaunchBuyOnlyWhitelist(address user, bool value) external onlyOwner { preLaunchBuyOnlyWhitelist[user] = value; }
    function setPreLaunchBuyOnlyWhitelistBatch(address[] calldata users, bool value) external onlyOwner {
        for (uint256 i = 0; i < users.length; i++) {
            preLaunchBuyOnlyWhitelist[users[i]] = value;
        }
    }
    function setPreLaunchWhitelistEnabled(bool value) external onlyOwner { preLaunchWhitelistEnabled = value; }
    function setPair(address pair, bool value) external onlyOwner {
        require(pair != address(0) && pair.code.length > 0, "invalid pair");
        _setPair(pair, value);
    }
    function _setPair(address pair, bool value) private {
        automatedMarketMakerPairs[pair] = value; _setDividendExcluded(pair, value); emit PairSet(pair, value);
    }
    function setTaxes(uint256 buyBP, uint256 sellBP) external onlyOwner { require(buyBP <= 2000 && sellBP <= 2000, "tax > 20%"); buyTaxBP = buyBP; sellTaxBP = sellBP; }
    function setTaxWallet(address value) external onlyOwner {
        require(value != address(0) && value != address(this), "invalid tax wallet");
        address old = taxWallet;
        if (old != owner() && old != address(this)) transferWhitelist[old] = false;
        _setDividendExcluded(old, false);
        taxWallet = value; transferWhitelist[value] = true; _setDividendExcluded(value, true);
    }
    function setLpReceiver(address value) external onlyOwner { require(value != address(0), "zero receiver"); lpReceiver = value; }
    function setLpReceiverMode(uint8 value) external onlyOwner { require(value <= 1, "bad lp mode"); lpReceiverMode = value; }
    function setLimits(uint256 buyAmount, uint256 walletAmount) external onlyOwner { maxBuyAmount = buyAmount; maxWalletAmount = walletAmount; }
    function openTrading() external onlyOwner { tradingOpen = true; if (launchTime == 0) launchTime = block.timestamp; }
    function setLaunchTime(uint256 value) external onlyOwner { require(!tradingOpen, "already open"); launchTime = value; }
    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }
    function setDividendExcluded(address user, bool value) external onlyOwner { _setDividendExcluded(user, value); }
    function _setDividendExcluded(address user, bool value) private {
        require(user != address(0), "zero address");
        uint256 bal = balanceOf(user);
        if (value && !dividendExcluded[user]) { withdrawnDividends[user] = accumulativeDividendOf(user); dividendExcluded[user] = true; excludedDividendSupply += bal; }
        else if (!value && dividendExcluded[user]) { dividendExcluded[user] = false; excludedDividendSupply -= bal; withdrawnDividends[user] = 0; magnifiedDividendCorrections[user] = -int256(magnifiedDividendPerShare * bal); }
    }
    function withdrawETH(uint256 amount) external onlyOwner nonReentrant {
        uint256 available = address(this).balance - dividendReserve; uint256 value = amount == 0 ? available : amount;
        require(value <= available, "exceeds available"); (bool ok,) = payable(owner()).call{value:value}(""); require(ok, "ETH transfer failed");
    }
    function withdrawToken(address token, uint256 amount) external onlyOwner {
        if (token == address(this)) {
            uint256 value = amount == 0 ? balanceOf(address(this)) : amount;
            _transfer(address(this), owner(), value);
        } else {
            IERC20 asset = IERC20(token); uint256 value = amount == 0 ? asset.balanceOf(address(this)) : amount; asset.safeTransfer(owner(), value);
        }
    }
}`;

const ABI = [
  "function owner() view returns(address)","function name() view returns(string)","function symbol() view returns(string)","function balanceOf(address) view returns(uint256)",
  "function ROUTER() view returns(address)","function FACTORY() view returns(address)","function WETH() view returns(address)","function mintPrice() view returns(uint256)","function userTokenPerMint() view returns(uint256)","function liquidityTokenPerMint() view returns(uint256)","function liquidityEthBP() view returns(uint256)","function maxMintCount() view returns(uint256)","function maxMintPerWallet() view returns(uint256)","function mintedCount() view returns(uint256)","function walletMintCount(address) view returns(uint256)","function mintEnabled() view returns(bool)","function tradingOpen() view returns(bool)","function launchTime() view returns(uint256)","function buyTaxBP() view returns(uint256)","function sellTaxBP() view returns(uint256)","function taxWallet() view returns(address)","function lpReceiver() view returns(address)","function lpReceiverMode() view returns(uint8)","function maxBuyAmount() view returns(uint256)","function maxWalletAmount() view returns(uint256)","function dividendReserve() view returns(uint256)","function withdrawableDividendOf(address) view returns(uint256)","function automatedMarketMakerPairs(address) view returns(bool)","function preLaunchWhitelist(address) view returns(bool)","function preLaunchBuyOnlyWhitelist(address) view returns(bool)",
  "function mint() payable","function claimDividends()","function createPairIfNeeded() returns(address)","function setMintConfig(uint256,uint256,uint256,uint256,uint256,uint256)","function setMintEnabled(bool)","function setMintWhitelistEnabled(bool)","function setMintWhitelist(address,bool)","function setMintWhitelistBatch(address[],bool)","function setBlacklist(address,bool)","function setTransferWhitelist(address,bool)","function setPreLaunchWhitelist(address,bool)","function setPreLaunchBuyOnlyWhitelist(address,bool)","function setPreLaunchBuyOnlyWhitelistBatch(address[],bool)","function setPreLaunchWhitelistEnabled(bool)","function setPair(address,bool)","function setTaxes(uint256,uint256)","function setTaxWallet(address)","function setLpReceiver(address)","function setLpReceiverMode(uint8)","function setLimits(uint256,uint256)","function openTrading()","function pause()","function unpause()","function fundDividends() payable","function setDividendExcluded(address,bool)","function withdrawETH(uint256)","function withdrawToken(address,uint256)","function renounceOwnership()"
];

const CHAIN = { id: 4663, hex: "0x1237", name: "Robinhood Chain", rpc: "https://rpc.mainnet.chain.robinhood.com/", explorer: "https://robinhoodchain.blockscout.com/" };
const OZ = "https://unpkg.com/@openzeppelin/contracts@5.0.2/";
const ZERO = ethers.ZeroAddress;
const state = { provider:null, signer:null, account:null, compiled:null, mint:null, admin:null, verifyInput:null, constructorArgs:"" };
const $ = id => document.getElementById(id);
const token = value => ethers.parseUnits(String(value || "0"), 18);
const eth = token;
const bp = value => BigInt(Math.round(Number(value || 0) * 100));
const bool = value => String(value) === "true";
const fmt = value => ethers.formatUnits(value ?? 0n, 18);
const log = value => { $("log").textContent = `[${new Date().toLocaleTimeString()}] ${value}\n` + $("log").textContent; };
const link = (kind,value) => `${CHAIN.explorer}${kind}/${value}`;
let linking = false;

function wallet() { return window.ethereum?.providers?.find(p => p.isMetaMask) || window.ethereum || null; }
async function switchChain(injected) {
  if (String(await injected.request({method:"eth_chainId"})).toLowerCase() === CHAIN.hex) return;
  try { await injected.request({method:"wallet_switchEthereumChain",params:[{chainId:CHAIN.hex}]}); }
  catch (error) {
    if (Number(error?.code) !== 4902) throw new Error("请切换到 Robinhood Chain 主网。");
    await injected.request({method:"wallet_addEthereumChain",params:[{chainId:CHAIN.hex,chainName:CHAIN.name,nativeCurrency:{name:"Ether",symbol:"ETH",decimals:18},rpcUrls:[CHAIN.rpc],blockExplorerUrls:[CHAIN.explorer]}]});
  }
}
async function connect() {
  const injected = wallet(); if (!injected) throw new Error("没有检测到 EVM 钱包。");
  await switchChain(injected); state.provider = new ethers.BrowserProvider(injected); await state.provider.send("eth_requestAccounts",[]);
  const network = await state.provider.getNetwork(); if (Number(network.chainId) !== CHAIN.id) throw new Error("当前不是 Robinhood Chain 主网。");
  state.signer = await state.provider.getSigner(); state.account = await state.signer.getAddress();
  $("walletAddress").textContent = state.account; $("networkName").textContent = `${CHAIN.name} · ${network.chainId}`;
  for (const name of ["owner","taxWallet","lpReceiver"]) { const el = document.querySelector(`[name="${name}"]`); if (el && !el.value) el.value = state.account; }
}
async function ensure() { if (!state.signer) await connect(); const n=await state.provider.getNetwork(); if(Number(n.chainId)!==CHAIN.id) throw new Error("请切换到 Robinhood Chain 主网。"); }

function resolveImport(path, fromSolcPath) {
  if (path.startsWith("@openzeppelin/")) return path;
  const base = fromSolcPath.split("/").slice(0, -1).join("/") + "/";
  const stack = (base + path).split("/");
  const out = [];
  for (const part of stack) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}
function sourceUrl(solcPath) {
  if (solcPath.startsWith("@openzeppelin/contracts/")) return OZ + solcPath.replace("@openzeppelin/contracts/","");
  throw new Error(`未知依赖路径：${solcPath}`);
}
async function fetchSource(solcPath, sources) {
  if (sources[solcPath]) return;
  const url = sourceUrl(solcPath);
  const text = await fetch(url).then(r => { if (!r.ok) throw new Error(`下载依赖失败：${url}`); return r.text(); });
  sources[solcPath] = { content:text };
  for (const match of text.matchAll(/import\s+(?:[^;"']+\s+from\s+)?(?:"([^"]+)"|'([^']+)');/g)) await fetchSource(resolveImport(match[1] || match[2], solcPath), sources);
}
async function collectSources() {
  const sources = { "RobinhoodV2AutoLiquidityMint.sol": { content: SOURCE } };
  for (const match of SOURCE.matchAll(/import\s+(?:[^;"']+\s+from\s+)?(?:"([^"]+)"|'([^']+)');/g)) await fetchSource(resolveImport(match[1] || match[2], "RobinhoodV2AutoLiquidityMint.sol"), sources);
  return sources;
}
async function compile() {
  log("正在下载依赖并编译…"); const sources=await collectSources();
  const input={language:"Solidity",sources,settings:{viaIR:true,optimizer:{enabled:true,runs:200},outputSelection:{"*":{"*":["abi","evm.bytecode.object","evm.deployedBytecode.object"]}}}};
  state.verifyInput = input; renderVerifyData();
  const workerCode=`import solc from "https://esm.sh/solc@0.8.24"; onmessage=e=>{try{postMessage({ok:true,value:solc.compile(JSON.stringify(e.data))})}catch(x){postMessage({ok:false,error:x.message})}}`;
  const worker=new Worker(URL.createObjectURL(new Blob([workerCode],{type:"text/javascript"})),{type:"module"});
  const output=await new Promise((resolve,reject)=>{worker.onmessage=e=>e.data.ok?resolve(JSON.parse(e.data.value)):reject(new Error(e.data.error));worker.onerror=reject;worker.postMessage(input);});
  worker.terminate();
  const errors=(output.errors||[]).filter(e=>e.severity==="error"); if(errors.length) throw new Error(errors.map(e=>e.formattedMessage).join("\n"));
  const c=output.contracts["RobinhoodV2AutoLiquidityMint.sol"].RobinhoodV2AutoLiquidityMint;
  state.compiled={abi:c.abi,bytecode:"0x"+c.evm.bytecode.object};
  renderVerifyData();
  log(`编译完成：ABI ${c.abi.length} 项；创建代码 ${c.evm.bytecode.object.length/2} bytes；运行时代码 ${c.evm.deployedBytecode.object.length/2} bytes`);
}

function launchTs(form) { if (form.launchMode.value !== "1" || !form.launchTime.value) return 0n; return BigInt(Math.floor(new Date(form.launchTime.value).getTime()/1000)); }
function args(form) {
  const owner = form.owner.value.trim() || state.account;
  const taxWallet = form.taxWallet.value.trim() || owner;
  const lpReceiver = form.lpReceiver.value.trim() || owner;
  return [
    form.name.value.trim(), form.symbol.value.trim(), token(form.totalSupply.value), owner, taxWallet, lpReceiver, Number(form.lpReceiverMode.value || 0),
    eth(form.mintPrice.value), token(form.userTokenPerMint.value), token(form.liquidityTokenPerMint.value), bp(form.liquidityEthPercent.value),
    BigInt(form.maxMintCount.value), BigInt(form.maxMintPerWallet.value), bool(form.mintWhitelistEnabled.value),
    launchTs(form), bool(form.preLaunchWhitelistEnabled.value), bp(form.buyTax.value), bp(form.sellTax.value), token(form.maxBuyAmount.value), token(form.maxWalletAmount.value)
  ];
}
const CONSTRUCTOR_TYPES = ["string","string","uint256","address","address","address","uint8","uint256","uint256","uint256","uint256","uint256","uint256","bool","uint256","bool","uint256","uint256","uint256","uint256"];
function renderVerifyData() {
  if ($("verifyJson") && state.verifyInput) $("verifyJson").value = JSON.stringify(state.verifyInput, null, 2);
  if ($("constructorArgs")) $("constructorArgs").value = state.constructorArgs || "";
}
async function generateVerifyData() {
  if (!state.verifyInput) {
    const sources = await collectSources();
    state.verifyInput = {language:"Solidity",sources,settings:{viaIR:true,optimizer:{enabled:true,runs:200},outputSelection:{"*":{"*":["abi","evm.bytecode.object","evm.deployedBytecode.object"]}}}};
  }
  const form = $("deployForm");
  if (form) {
    state.constructorArgs = ethers.AbiCoder.defaultAbiCoder().encode(CONSTRUCTOR_TYPES, args(form)).slice(2);
  }
  renderVerifyData();
  log("验证资料已生成。Blockscout 验证方式请选择 Standard JSON Input；构造参数复制下方 ABI-encoded 内容。");
}
function updatePlan() {
  const form=$("deployForm"); if(!form) return;
  const user=Number(form.userTokenPerMint.value||0), lp=Number(form.liquidityTokenPerMint.value||0), count=Number(form.maxMintCount.value||0), supply=Number(form.totalSupply.value||0), ethPct=Number(form.liquidityEthPercent.value||0), price=Number(form.mintPrice.value||0);
  const need=(user+lp)*count;
  const ethForPool = price * ethPct / 100 * count;
  const ethRaised = price * count;
  const retainedEth = ethRaised - ethForPool;
  const referenceTokenPerEth = ethForPool > 0 ? (lp * count / ethForPool) : 0;
  $("mintPlan").innerHTML=[
    ["每次拆分", `用户 ${user.toLocaleString()} / 加池 ${lp.toLocaleString()} Token`],
    ["用户总到账", `${(user*count).toLocaleString()} Token`],
    ["自动加池总预留", `${(lp*count).toLocaleString()} Token + ${ethForPool.toLocaleString()} ETH`],
    ["Mint 总募资", `${ethRaised.toLocaleString()} ETH`],
    ["Owner 留存 ETH", `${retainedEth.toLocaleString()} ETH`],
    ["参考开盘比例", referenceTokenPerEth ? `1 ETH ≈ ${Math.round(referenceTokenPerEth).toLocaleString()} Token` : "ETH 加池为 0"],
    ["Mint 计划占供应", supply ? `${(need/supply*100).toFixed(4)}%` : "0%"]
  ].map(([k,v])=>`<article><span>${k}</span><strong>${v}</strong></article>`).join("");
}
function num(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}
function setValue(input, value, decimals = 0) {
  if (!input || !Number.isFinite(value)) return;
  const normalized = decimals > 0 ? Number(value).toFixed(decimals).replace(/\.?0+$/,"") : String(Math.max(0, Math.floor(value)));
  input.value = normalized === "" ? "0" : normalized;
}
function splitTotalToUserAndLiquidity() {
  const form = $("deployForm"); if (!form) return;
  const total = num(form.totalTokenPerMintCalc?.value);
  const percent = num(form.userTokenPercentCalc?.value);
  if (total <= 0 || percent < 0 || percent > 100) return;
  const userTokens = Math.floor(total * percent / 100);
  const liquidityTokens = Math.max(0, Math.floor(total - userTokens));
  form.userTokenPerMint.value = String(userTokens);
  form.liquidityTokenPerMint.value = String(liquidityTokens);
}
function allocationMode() {
  const form = $("deployForm");
  return form?.mintAllocationMode?.value || "ratio";
}
function applyAllocationMode() {
  const form = $("deployForm"); if (!form) return;
  const ratioMode = allocationMode() === "ratio";
  if (form.userTokenPercentCalc) form.userTokenPercentCalc.readOnly = !ratioMode;
  if (form.userTokenPerMint) form.userTokenPerMint.readOnly = ratioMode;
  if (form.liquidityTokenPerMint) form.liquidityTokenPerMint.readOnly = ratioMode;
  document.querySelectorAll('[data-mode-field="ratio"]').forEach(el => { el.hidden = !ratioMode; });
  document.querySelectorAll('[data-mode-field="amount"]').forEach(el => { el.hidden = ratioMode; });
  if (form.userTokenPerMint) form.userTokenPerMint.title = ratioMode ? "按比例模式下自动计算；如需手填请切换为按数量填写" : "";
  if (form.liquidityTokenPerMint) form.liquidityTokenPerMint.title = ratioMode ? "按比例模式下自动计算；如需手填请切换为按数量填写" : "";
  if (form.userTokenPercentCalc) form.userTokenPercentCalc.title = ratioMode ? "" : "按数量填写模式下由到账数量反推；如需编辑比例请切换为按比例计算";
  if ($("mintModeHint")) $("mintModeHint").textContent = ratioMode
    ? "当前为按比例计算：填写每次总分配代币和用户到账比例，页面会自动算出实际部署用的到账数量和加池数量。"
    : "当前为按数量填写：直接填写用户到账代币/次和自动加池代币/次，页面会反推总分配和占比。";
  if (ratioMode) setLinkedMintFields();
  else syncLinkedMintDisplay();
}
function applyLpReceiverMode() {
  const form = $("deployForm"); if (!form) return;
  const fixed = String(form.lpReceiverMode?.value || "0") === "0";
  document.querySelectorAll("[data-lp-fixed]").forEach(el => { el.hidden = !fixed; });
  updatePlan();
}
function recalcTotalPerMintFromSupply() {
  const form = $("deployForm"); if (!form || linking) return;
  linking = true;
  const supply = num(form.totalSupply.value);
  const count = num(form.maxMintCount.value);
  const planPercent = num(form.mintSupplyPercentCalc?.value);
  if (supply > 0 && count > 0 && planPercent > 0) {
    setValue(form.totalTokenPerMintCalc, supply * planPercent / 100 / count);
    if (allocationMode() === "ratio") splitTotalToUserAndLiquidity();
  }
  linking = false;
  if (allocationMode() === "amount") syncLinkedMintDisplay();
  updatePlan();
}
function recalcPlanPercentFromTotalPerMint() {
  const form = $("deployForm"); if (!form || linking) return;
  linking = true;
  const total = num(form.totalTokenPerMintCalc?.value);
  const count = num(form.maxMintCount.value);
  const supply = num(form.totalSupply.value);
  if (total > 0 && count > 0 && supply > 0) setValue(form.mintSupplyPercentCalc, total * count / supply * 100, 4);
  if (allocationMode() === "ratio") splitTotalToUserAndLiquidity();
  linking = false;
  updatePlan();
}
function setLinkedMintFields() {
  if (linking) return;
  if (allocationMode() !== "ratio") { updatePlan(); return; }
  linking = true;
  splitTotalToUserAndLiquidity();
  linking = false;
  updatePlan();
}
function syncLinkedMintDisplay() {
  const form = $("deployForm"); if (!form || linking) return;
  if (allocationMode() !== "amount") { updatePlan(); return; }
  linking = true;
  const user = num(form.userTokenPerMint.value);
  const lp = num(form.liquidityTokenPerMint.value);
  const total = user + lp;
  if (total <= 0) { linking = false; return; }
  if (form.totalTokenPerMintCalc) form.totalTokenPerMintCalc.value = String(total);
  if (form.userTokenPercentCalc) setValue(form.userTokenPercentCalc, user / total * 100, 4);
  const count = num(form.maxMintCount.value);
  const supply = num(form.totalSupply.value);
  if (count > 0 && supply > 0) setValue(form.mintSupplyPercentCalc, total * count / supply * 100, 4);
  linking = false;
  updatePlan();
}
async function deploy(form) {
  await ensure(); if(!state.compiled) await compile(); const a=args(form);
  if((a[8]+a[9])*a[11]>a[2]) throw new Error("Mint 用户到账 + 加池代币的总量超过总供应量。");
  state.constructorArgs = ethers.AbiCoder.defaultAbiCoder().encode(CONSTRUCTOR_TYPES, a).slice(2); renderVerifyData();
  const factory=new ethers.ContractFactory(state.compiled.abi,state.compiled.bytecode,state.signer);
  log("请在钱包确认部署交易…"); const c=await factory.deploy(...a); const tx=c.deploymentTransaction();
  log(`部署交易：${link("tx",tx.hash)}`); await c.waitForDeployment(); const address=await c.getAddress();
  log(`部署完成：${address}`); $("deploymentLink").href=link("address",address); $("deploymentLink").textContent=`在 Blockscout 查看 ${address}`;
  $("mintContractAddress").value=address; $("adminContractAddress").value=address; state.mint=new ethers.Contract(address,ABI,state.signer); state.admin=state.mint;
}
async function at(address) { await ensure(); if(!ethers.isAddress(address)||address===ZERO) throw new Error("合约地址不正确。"); if(await state.provider.getCode(address)==="0x") throw new Error("该地址没有合约代码。"); return new ethers.Contract(address,ABI,state.signer); }
async function done(tx,label) { log(`${label} 已提交：${link("tx",tx.hash)}`); await tx.wait(); log(`${label} 已确认`); }
function stats(id,rows){$(id).innerHTML=rows.map(([k,v])=>`<article><span>${k}</span><strong>${v}</strong></article>`).join("");}
function parseAddresses(text) {
  const list = String(text || "").split(/[\s,;，；]+/).map(x => x.trim()).filter(Boolean);
  const invalid = list.filter(x => !ethers.isAddress(x));
  if (invalid.length) throw new Error(`地址格式不正确：${invalid.slice(0,3).join(", ")}`);
  return [...new Set(list.map(x => ethers.getAddress(x)))];
}
async function refreshMint() {
  const c=state.mint; if(!c)return; const me=state.account||ZERO;
  const [name,symbol,price,userToken,lpToken,lpBP,maxCount,minted,myCount,enabled,dividend]=await Promise.all([c.name(),c.symbol(),c.mintPrice(),c.userTokenPerMint(),c.liquidityTokenPerMint(),c.liquidityEthBP(),c.maxMintCount(),c.mintedCount(),c.walletMintCount(me),c.mintEnabled(),c.withdrawableDividendOf(me)]);
  stats("mintStats",[["代币",`${name} (${symbol})`],["Mint 价格",`${fmt(price)} ETH`],["用户到账/次",fmt(userToken)],["自动加池/次",`${fmt(lpToken)} Token + ${Number(lpBP)/100}% ETH`],["进度",`${minted}/${maxCount}`],["我的次数",myCount.toString()],["Mint 状态",enabled?"开启":"关闭"],["可领分红",`${fmt(dividend)} ETH`]]);
}
async function refreshAdmin() {
  const c=state.admin; if(!c)return; const [owner,router,factory,weth,taxWallet,lpReceiver,lpMode,buy,sell,maxBuy,maxWallet,reserve,open,launch,price,userToken,lpToken,lpBP,maxCount,maxPer,minted]=await Promise.all([c.owner(),c.ROUTER(),c.FACTORY(),c.WETH(),c.taxWallet(),c.lpReceiver(),c.lpReceiverMode(),c.buyTaxBP(),c.sellTaxBP(),c.maxBuyAmount(),c.maxWalletAmount(),c.dividendReserve(),c.tradingOpen(),c.launchTime(),c.mintPrice(),c.userTokenPerMint(),c.liquidityTokenPerMint(),c.liquidityEthBP(),c.maxMintCount(),c.maxMintPerWallet(),c.mintedCount()]);
  stats("adminStats",[["Owner",owner],["Router",router],["Factory / WETH",`${factory} / ${weth}`],["税费钱包",taxWallet],["LP 接收方式",Number(lpMode)===1?"Mint 用户接收":`指定钱包：${lpReceiver}`],["买/卖税",`${Number(buy)/100}% / ${Number(sell)/100}%`],["限购",`单笔 ${fmt(maxBuy)} / 持仓 ${fmt(maxWallet)}`],["分红储备",`${fmt(reserve)} ETH`],["开盘",open?`已开盘`:(Number(launch)>0?new Date(Number(launch)*1000).toLocaleString():"未开盘")],["Mint 配置",`${fmt(price)} ETH；到账 ${fmt(userToken)}；加池 ${fmt(lpToken)} + ${Number(lpBP)/100}% ETH`],["Mint 进度",`${minted}/${maxCount}；每钱包 ${maxPer}`]]);
}
async function adminAction(name) {
  const c=state.admin; if(!c)throw new Error("请先加载管理合约。"); const value=bool($("listValue").value);
  const calls={
    setMintConfig:()=>c.setMintConfig(eth($("newMintPrice").value),token($("newUserTokenPerMint").value),token($("newLiquidityTokenPerMint").value),bp($("newLiquidityEthPercent").value),BigInt($("newMaxMintCount").value),BigInt($("newMaxMintPerWallet").value)),
    setMintEnabled:()=>c.setMintEnabled(bool($("mintEnabled").value)),
    setMintWhitelistEnabled:()=>c.setMintWhitelistEnabled(bool($("mintWhitelistEnabled").value)),
    createPairIfNeeded:()=>c.createPairIfNeeded(),
    setPair:()=>c.setPair($("pairAddress").value.trim(),bool($("pairValue").value)),
    setLpReceiver:()=>c.setLpReceiver($("lpReceiver").value.trim()),
    setMintWhitelist:()=>c.setMintWhitelist($("listAddress").value,value),
    setMintWhitelistBatch:()=>{const users=parseAddresses($("batchMintWhitelist").value);if(!users.length)throw new Error("请先输入白名单地址。");return c.setMintWhitelistBatch(users,bool($("batchMintWhitelistValue").value))},
    setBlacklist:()=>c.setBlacklist($("listAddress").value,value),
    setTransferWhitelist:()=>c.setTransferWhitelist($("listAddress").value,value),
    setPreLaunchWhitelist:()=>c.setPreLaunchWhitelist($("listAddress").value,value),
    setPreLaunchBuyOnlyWhitelist:()=>c.setPreLaunchBuyOnlyWhitelist($("listAddress").value,value),
    setPreLaunchBuyOnlyWhitelistBatch:()=>{const users=parseAddresses($("batchMintWhitelist").value);if(!users.length)throw new Error("请先输入白名单地址。");return c.setPreLaunchBuyOnlyWhitelistBatch(users,bool($("batchMintWhitelistValue").value))},
    setPreLaunchWhitelistEnabled:()=>c.setPreLaunchWhitelistEnabled(bool($("preLaunchWhitelistEnabled").value)),
    setDividendExcluded:()=>c.setDividendExcluded($("listAddress").value,value),
    setTaxes:()=>c.setTaxes(bp($("buyTax").value),bp($("sellTax").value)),
    setTaxWallet:()=>c.setTaxWallet($("taxWallet").value.trim()),
    setLimits:()=>c.setLimits(token($("maxBuyAmount").value),token($("maxWalletAmount").value)),
    setLpReceiverMode:()=>c.setLpReceiverMode(Number($("lpReceiverMode").value || 0)),
    openTrading:()=>c.openTrading(),
    pause:()=>c.pause(),
    unpause:()=>c.unpause(),
    fundDividends:()=>c.fundDividends({value:eth($("dividendAmount").value)}),
    withdrawETH:()=>c.withdrawETH($("withdrawETHAmount").value?eth($("withdrawETHAmount").value):0n),
    withdrawToken:async()=>{const address=$("adminContractAddress").value.trim();const asset=$("withdrawTokenAddress").value.trim()||address;let amount=0n;if($("withdrawTokenAmount").value)amount=token($("withdrawTokenAmount").value);return c.withdrawToken(asset,amount)},
    renounceOwnership:()=>{if(!confirm("确认丢弃 Owner 权限？此操作不可恢复，丢弃后无法再管理 Mint、税率、白名单、提取等功能。")) throw new Error("已取消丢弃权限。"); return c.renounceOwnership();}
  };
  if(!calls[name])throw new Error("未知操作"); await done(await calls[name](),name); await refreshAdmin();
}
async function run(button,fn){button&&(button.disabled=true);try{await fn()}catch(e){log(`错误：${e.shortMessage||e.reason||e.message||e}`)}finally{button&&(button.disabled=false)}}

document.addEventListener("DOMContentLoaded",()=>{
  recalcTotalPerMintFromSupply();
  applyAllocationMode();
  applyLpReceiverMode();
  updatePlan();
  document.querySelector('[name="mintAllocationMode"]')?.addEventListener("input",applyAllocationMode);
  document.querySelector('[name="lpReceiverMode"]')?.addEventListener("input",applyLpReceiverMode);
  document.querySelectorAll('[name="totalSupply"],[name="maxMintCount"],[name="mintSupplyPercentCalc"]').forEach(input=>input.addEventListener("input",recalcTotalPerMintFromSupply));
  document.querySelector('[name="totalTokenPerMintCalc"]')?.addEventListener("input",recalcPlanPercentFromTotalPerMint);
  document.querySelector('[name="userTokenPercentCalc"]')?.addEventListener("input",setLinkedMintFields);
  document.querySelectorAll('[name="userTokenPerMint"],[name="liquidityTokenPerMint"]').forEach(input=>input.addEventListener("input",syncLinkedMintDisplay));
  $("connectWallet").addEventListener("click",e=>run(e.currentTarget,connect));
  $("compileContract").addEventListener("click",e=>run(e.currentTarget,compile));
  $("generateVerifyData")?.addEventListener("click",e=>run(e.currentTarget,generateVerifyData));
  document.querySelectorAll("[data-copy]").forEach(button=>button.addEventListener("click",async e=>{
    const target=$(e.currentTarget.dataset.copy); const text=target?.value||"";
    if(!text) return log("没有可复制的内容，请先生成验证资料。");
    await navigator.clipboard.writeText(text); log("已复制到剪贴板。");
  }));
  $("deployForm").addEventListener("input",updatePlan);
  $("deployForm").addEventListener("submit",e=>{e.preventDefault();run(e.submitter,()=>deploy(e.currentTarget));});
  document.querySelectorAll(".tab").forEach(button=>button.addEventListener("click",()=>{document.querySelectorAll(".tab,.panel").forEach(x=>x.classList.remove("active"));button.classList.add("active");$(button.dataset.tab).classList.add("active");}));
  $("loadMint").addEventListener("click",e=>run(e.currentTarget,async()=>{state.mint=await at($("mintContractAddress").value.trim());await refreshMint();}));
  $("mintNow").addEventListener("click",e=>run(e.currentTarget,async()=>{if(!state.mint)state.mint=await at($("mintContractAddress").value.trim());await done(await state.mint.mint({value:await state.mint.mintPrice()}),"Mint");await refreshMint();}));
  $("claimDividend").addEventListener("click",e=>run(e.currentTarget,async()=>{if(!state.mint)state.mint=await at($("mintContractAddress").value.trim());await done(await state.mint.claimDividends(),"领取分红");await refreshMint();}));
  $("loadAdmin").addEventListener("click",e=>run(e.currentTarget,async()=>{state.admin=await at($("adminContractAddress").value.trim());await refreshAdmin();}));
  $("refreshAdmin").addEventListener("click",e=>run(e.currentTarget,refreshAdmin));
  document.querySelectorAll("[data-action]").forEach(button=>button.addEventListener("click",e=>run(e.currentTarget,()=>adminAction(e.currentTarget.dataset.action))));
  log("V2 自动加池版本已加载。部署前请确认参数：用户到账、加池代币、ETH 加池比例、LP 接收地址。");
});
