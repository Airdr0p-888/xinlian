import { ethers } from "https://cdn.jsdelivr.net/npm/ethers@6.13.5/dist/ethers.min.js";

const SOURCE = String.raw`// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract RobinhoodV3FairMint is ERC20, Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    uint256 private constant MAGNITUDE = 2 ** 128;

    uint256 public mintPrice;
    uint256 public tokenPerMint;
    uint256 public maxMintCount;
    uint256 public maxMintPerWallet;
    uint256 public mintedCount;
    bool public mintEnabled = true;
    bool public mintWhitelistEnabled;
    mapping(address => uint256) public walletMintCount;
    mapping(address => bool) public mintWhitelist;

    bool public tradingOpen;
    uint256 public launchTime;
    bool public preLaunchWhitelistEnabled;
    mapping(address => bool) public preLaunchWhitelist;
    mapping(address => bool) public v3Pools;
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

    event Minted(address indexed user, uint256 indexed number, uint256 tokenAmount, uint256 ethAmount);
    event V3PoolSet(address indexed pool, bool enabled);
    event DividendsFunded(address indexed sender, uint256 amount);
    event DividendClaimed(address indexed user, uint256 amount);

    constructor(
        string memory name_, string memory symbol_, uint256 supply_, address owner_, address taxWallet_,
        uint256 mintPrice_, uint256 tokenPerMint_, uint256 maxMintCount_, uint256 maxMintPerWallet_,
        bool mintWhitelistEnabled_, uint256 launchTime_, bool preLaunchWhitelistEnabled_,
        uint256 buyTaxBP_, uint256 sellTaxBP_, uint256 maxBuyAmount_, uint256 maxWalletAmount_
    ) ERC20(name_, symbol_) Ownable(owner_) {
        require(supply_ > 0 && tokenPerMint_ > 0, "zero config"); require(taxWallet_ != address(0), "tax wallet zero");
        require(maxMintCount_ > 0 && maxMintPerWallet_ > 0, "bad mint limit");
        require(tokenPerMint_ * maxMintCount_ <= supply_, "mint plan exceeds supply");
        require(buyTaxBP_ <= 2000 && sellTaxBP_ <= 2000, "tax > 20%");
        mintPrice = mintPrice_; tokenPerMint = tokenPerMint_; maxMintCount = maxMintCount_;
        maxMintPerWallet = maxMintPerWallet_; mintWhitelistEnabled = mintWhitelistEnabled_;
        launchTime = launchTime_; preLaunchWhitelistEnabled = preLaunchWhitelistEnabled_;
        buyTaxBP = buyTaxBP_; sellTaxBP = sellTaxBP_; taxWallet = taxWallet_; maxBuyAmount = maxBuyAmount_; maxWalletAmount = maxWalletAmount_;
        transferWhitelist[owner_] = true; transferWhitelist[address(this)] = true;
        transferWhitelist[taxWallet_] = true;
        preLaunchWhitelist[owner_] = true; preLaunchWhitelist[address(this)] = true;
        dividendExcluded[address(this)] = true;
        dividendExcluded[taxWallet_] = true;
        _mint(address(this), supply_);
    }

    receive() external payable {}

    function mint() external payable nonReentrant whenNotPaused {
        require(mintEnabled, "mint disabled");
        require(msg.value == mintPrice, "bad ETH amount");
        require(mintedCount < maxMintCount, "mint full");
        require(walletMintCount[msg.sender] < maxMintPerWallet, "wallet mint limit");
        if (mintWhitelistEnabled) require(mintWhitelist[msg.sender], "not mint whitelist");
        require(balanceOf(address(this)) >= tokenPerMint, "insufficient token reserve");
        unchecked { mintedCount++; walletMintCount[msg.sender]++; }
        _transfer(address(this), msg.sender, tokenPerMint);
        emit Minted(msg.sender, mintedCount, tokenPerMint, msg.value);
    }

    function _update(address from, address to, uint256 amount) internal override {
        if (from == address(0) || to == address(0)) { _move(from, to, amount); return; }
        require(!paused(), "paused");
        require(!blacklist[from] && !blacklist[to], "blacklisted");
        bool buy = v3Pools[from]; bool sell = v3Pools[to];
        if (buy || sell) {
            if (!tradingOpen && (launchTime == 0 || block.timestamp < launchTime)) {
                require(!preLaunchWhitelistEnabled || preLaunchWhitelist[from] || preLaunchWhitelist[to], "trading not open");
            }
        }
        uint256 tax;
        if (!transferWhitelist[from] && !transferWhitelist[to]) {
            if (buy) tax = amount * buyTaxBP / 10000;
            else if (sell) tax = amount * sellTaxBP / 10000;
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

    function eligibleDividendSupply() public view returns (uint256 value) {
        value = totalSupply() - excludedDividendSupply;
    }

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

    function setMintConfig(uint256 price, uint256 perMint, uint256 maxCount, uint256 perWallet) external onlyOwner {
        require(perMint > 0 && maxCount >= mintedCount && perWallet > 0, "bad config");
        require(perMint * maxCount <= totalSupply(), "plan exceeds supply");
        mintPrice = price; tokenPerMint = perMint; maxMintCount = maxCount; maxMintPerWallet = perWallet;
    }
    function setMintEnabled(bool value) external onlyOwner { mintEnabled = value; }
    function setMintWhitelistEnabled(bool value) external onlyOwner { mintWhitelistEnabled = value; }
    function setMintWhitelist(address user, bool value) external onlyOwner { mintWhitelist[user] = value; }
    function setBlacklist(address user, bool value) external onlyOwner { blacklist[user] = value; }
    function setTransferWhitelist(address user, bool value) external onlyOwner { transferWhitelist[user] = value; }
    function setPreLaunchWhitelist(address user, bool value) external onlyOwner { preLaunchWhitelist[user] = value; }
    function setPreLaunchWhitelistEnabled(bool value) external onlyOwner { preLaunchWhitelistEnabled = value; }
    function setV3Pool(address pool, bool value) external onlyOwner {
        require(pool != address(0) && pool.code.length > 0, "invalid pool");
        v3Pools[pool] = value; _setDividendExcluded(pool, value); emit V3PoolSet(pool, value);
    }
    function setTaxes(uint256 buyBP, uint256 sellBP) external onlyOwner { require(buyBP <= 2000 && sellBP <= 2000, "tax > 20%"); buyTaxBP = buyBP; sellTaxBP = sellBP; }
    function setTaxWallet(address value) external onlyOwner {
        require(value != address(0) && value != address(this), "invalid tax wallet");
        address old = taxWallet;
        if (old != owner() && old != address(this)) transferWhitelist[old] = false;
        _setDividendExcluded(old, false);
        taxWallet = value; transferWhitelist[value] = true; _setDividendExcluded(value, true);
    }
    function setLimits(uint256 buyAmount, uint256 walletAmount) external onlyOwner { maxBuyAmount = buyAmount; maxWalletAmount = walletAmount; }
    function openTrading() external onlyOwner { tradingOpen = true; if (launchTime == 0) launchTime = block.timestamp; }
    function setLaunchTime(uint256 value) external onlyOwner { require(!tradingOpen, "already open"); launchTime = value; }
    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }
    function setDividendExcluded(address user, bool value) external onlyOwner {
        _setDividendExcluded(user, value);
    }
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
        IERC20 asset = IERC20(token); uint256 value = amount == 0 ? asset.balanceOf(address(this)) : amount; asset.safeTransfer(owner(), value);
    }
}`;

const ABI = [
  "function owner() view returns(address)","function name() view returns(string)","function symbol() view returns(string)","function balanceOf(address) view returns(uint256)",
  "function mintPrice() view returns(uint256)","function tokenPerMint() view returns(uint256)","function maxMintCount() view returns(uint256)","function maxMintPerWallet() view returns(uint256)","function mintedCount() view returns(uint256)","function walletMintCount(address) view returns(uint256)","function mintEnabled() view returns(bool)","function tradingOpen() view returns(bool)","function launchTime() view returns(uint256)","function buyTaxBP() view returns(uint256)","function sellTaxBP() view returns(uint256)","function taxWallet() view returns(address)","function maxBuyAmount() view returns(uint256)","function maxWalletAmount() view returns(uint256)","function dividendReserve() view returns(uint256)","function withdrawableDividendOf(address) view returns(uint256)",
  "function mint() payable","function claimDividends()","function setMintConfig(uint256,uint256,uint256,uint256)","function setMintEnabled(bool)","function setMintWhitelistEnabled(bool)","function setMintWhitelist(address,bool)","function setBlacklist(address,bool)","function setTransferWhitelist(address,bool)","function setPreLaunchWhitelist(address,bool)","function setPreLaunchWhitelistEnabled(bool)","function setV3Pool(address,bool)","function setTaxes(uint256,uint256)","function setTaxWallet(address)","function setLimits(uint256,uint256)","function openTrading()","function pause()","function unpause()","function fundDividends() payable","function setDividendExcluded(address,bool)","function withdrawETH(uint256)","function withdrawToken(address,uint256)"
];

const CHAIN = { id: 4663, hex: "0x1237", name: "Robinhood Chain", rpc: "https://rpc.mainnet.chain.robinhood.com/", explorer: "https://robinhoodchain.blockscout.com/" };
const OZ = "https://unpkg.com/@openzeppelin/contracts@5.0.2/";
const ZERO = ethers.ZeroAddress;
const state = { provider:null, signer:null, account:null, compiled:null, mint:null, admin:null };
const $ = id => document.getElementById(id);
const token = value => ethers.parseUnits(String(value || "0"), 18);
const bp = value => BigInt(Math.round(Number(value || 0) * 100));
const bool = value => String(value) === "true";
const log = value => { $("log").textContent = `[${new Date().toLocaleTimeString()}] ${value}\n` + $("log").textContent; };
const link = (kind,value) => `${CHAIN.explorer}${kind}/${value}`;

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
  const owner = document.querySelector('[name="owner"]'); if (!owner.value) owner.value = state.account;
  const taxWallet = document.querySelector('[name="taxWallet"]'); if (!taxWallet.value) taxWallet.value = state.account;
}
async function ensure() { if (!state.signer) await connect(); const n=await state.provider.getNetwork(); if(Number(n.chainId)!==CHAIN.id) throw new Error("请切换到 Robinhood Chain 主网。"); }

function resolveImport(path, from) {
  if (path.startsWith("@openzeppelin/contracts/")) return path;
  const parts = from.split("/"); parts.pop(); for (const p of path.split("/")) { if(p==="..") parts.pop(); else if(p!=="."&&p) parts.push(p); } return parts.join("/");
}
async function collectSources() {
  const sources = {"RobinhoodV3FairMint.sol":{content:SOURCE}}; const queue=["RobinhoodV3FairMint.sol"];
  while(queue.length) { const file=queue.shift(), content=sources[file].content; const re=/import\s+(?:[^"']+from\s+)?["']([^"']+)["'];/g; let m;
    while((m=re.exec(content))) { const resolved=resolveImport(m[1],file); if(sources[resolved]) continue; if(!resolved.startsWith("@openzeppelin/contracts/")) throw new Error(`不支持的依赖 ${resolved}`); const url=OZ+resolved.replace("@openzeppelin/contracts/",""); const response=await fetch(url); if(!response.ok) throw new Error(`依赖下载失败 ${resolved}`); sources[resolved]={content:await response.text()}; queue.push(resolved); }
  } return sources;
}
async function compile() {
  log("正在下载依赖并编译…"); const sources=await collectSources();
  const input={language:"Solidity",sources,settings:{viaIR:true,optimizer:{enabled:true,runs:200},outputSelection:{"*":{"*":["abi","evm.bytecode.object","evm.deployedBytecode.object"]}}}};
  const workerCode=`import solc from "https://esm.sh/solc@0.8.24"; onmessage=e=>{try{postMessage({ok:true,value:solc.compile(JSON.stringify(e.data))})}catch(x){postMessage({ok:false,error:x.message})}}`;
  const url=URL.createObjectURL(new Blob([workerCode],{type:"text/javascript"})); const worker=new Worker(url,{type:"module"});
  const raw=await new Promise((resolve,reject)=>{worker.onmessage=e=>e.data.ok?resolve(e.data.value):reject(new Error(e.data.error));worker.onerror=e=>reject(new Error(e.message));worker.postMessage(input)}); worker.terminate(); URL.revokeObjectURL(url);
  const output=JSON.parse(raw), errors=(output.errors||[]).filter(e=>e.severity==="error"); if(errors.length) throw new Error(errors.map(e=>e.formattedMessage).join("\n"));
  const artifact=output.contracts["RobinhoodV3FairMint.sol"].RobinhoodV3FairMint;
  const runtimeBytes=(artifact.evm.deployedBytecode.object||"").length/2, creationBytes=(artifact.evm.bytecode.object||"").length/2;
  if(runtimeBytes>24576) throw new Error(`运行时代码 ${runtimeBytes} bytes，超过 EVM 24576 bytes 上限。`);
  state.compiled={abi:artifact.abi,bytecode:"0x"+artifact.evm.bytecode.object}; log(`编译完成：ABI ${artifact.abi.length} 项；创建代码 ${creationBytes} bytes；运行时代码 ${runtimeBytes} bytes`);
}

function args(form) { const f=new FormData(form), launch=f.get("launchMode")==="1"&&f.get("launchTime")?Math.floor(new Date(f.get("launchTime")).getTime()/1000):0, owner=f.get("owner")||state.account; return [f.get("name"),f.get("symbol"),token(f.get("totalSupply")),owner,f.get("taxWallet")||owner,token(f.get("mintPrice")),token(f.get("tokenPerMint")),BigInt(f.get("maxMintCount")),BigInt(f.get("maxMintPerWallet")),bool(f.get("mintWhitelistEnabled")),BigInt(launch),bool(f.get("preLaunchWhitelistEnabled")),bp(f.get("buyTax")),bp(f.get("sellTax")),token(f.get("maxBuyAmount")),token(f.get("maxWalletAmount"))]; }
async function deploy(form) { await ensure(); if(!state.compiled) await compile(); const a=args(form); if(a[6]*a[7]>a[2]) throw new Error("Mint 计划发放量超过总供应量。"); const factory=new ethers.ContractFactory(state.compiled.abi,state.compiled.bytecode,state.signer); log("请在钱包确认部署交易…"); const c=await factory.deploy(...a); const tx=c.deploymentTransaction(); log(`部署交易：${link("tx",tx.hash)}`); await c.waitForDeployment(); const address=await c.getAddress(); log(`部署完成：${address}`); $("deploymentLink").href=link("address",address); $("deploymentLink").textContent=`在 Blockscout 查看 ${address}`; $("mintContractAddress").value=address; $("adminContractAddress").value=address; state.mint=new ethers.Contract(address,ABI,state.signer); state.admin=state.mint; }
async function at(address) { await ensure(); if(!ethers.isAddress(address)||address===ZERO) throw new Error("合约地址不正确。"); if(await state.provider.getCode(address)==="0x") throw new Error("该地址没有合约代码。"); return new ethers.Contract(address,ABI,state.signer); }
async function done(tx,label) { log(`${label} 已提交：${link("tx",tx.hash)}`); await tx.wait(); log(`${label} 已确认`); }
function stats(id,rows){$(id).innerHTML=rows.map(([k,v])=>`<article><span>${k}</span><strong>${v}</strong></article>`).join("");}
async function refreshMint(){const c=state.mint;if(!c)return;const [name,symbol,price,per,count,max,wm,wmax,en,pending]=await Promise.all([c.name(),c.symbol(),c.mintPrice(),c.tokenPerMint(),c.mintedCount(),c.maxMintCount(),c.walletMintCount(state.account),c.maxMintPerWallet(),c.mintEnabled(),c.withdrawableDividendOf(state.account)]);stats("mintStats",[["代币",`${name} (${symbol})`],["价格",`${ethers.formatEther(price)} ETH`],["每次到账",ethers.formatUnits(per,18)],["总进度",`${count}/${max}`],["钱包次数",`${wm}/${wmax}`],["Mint",en?"开启":"关闭"],["可领分红",`${ethers.formatEther(pending)} ETH`]]);}
async function refreshAdmin(){const c=state.admin;if(!c)return;const [owner,taxWallet,count,max,open,time,buy,sell,reserve,maxBuy,maxWallet]=await Promise.all([c.owner(),c.taxWallet(),c.mintedCount(),c.maxMintCount(),c.tradingOpen(),c.launchTime(),c.buyTaxBP(),c.sellTaxBP(),c.dividendReserve(),c.maxBuyAmount(),c.maxWalletAmount()]);stats("adminStats",[["Owner",owner],["税费接收钱包",taxWallet],["Mint",`${count}/${max}`],["交易",open?"已开启":`未开启 / ${Number(time)?new Date(Number(time)*1000).toLocaleString():"手动"}`],["买/卖税",`${Number(buy)/100}% / ${Number(sell)/100}%`],["单笔/持仓上限",`${ethers.formatUnits(maxBuy,18)} / ${ethers.formatUnits(maxWallet,18)}`],["分红储备",`${ethers.formatEther(reserve)} ETH`]]);}
async function action(name){await ensure();const c=state.admin||(state.admin=await at($("adminContractAddress").value.trim()));const address=await c.getAddress(), value=bool($("listValue")?.value);const calls={
  setMintConfig:()=>c.setMintConfig(token($("newMintPrice").value),token($("newTokenPerMint").value),BigInt($("newMaxMintCount").value),BigInt($("newMaxMintPerWallet").value)),setMintEnabled:()=>c.setMintEnabled(bool($("mintEnabled").value)),setMintWhitelistEnabled:()=>c.setMintWhitelistEnabled(bool($("mintWhitelistEnabled").value)),setMintWhitelist:()=>c.setMintWhitelist($("listAddress").value,value),setBlacklist:()=>c.setBlacklist($("listAddress").value,value),setTransferWhitelist:()=>c.setTransferWhitelist($("listAddress").value,value),setPreLaunchWhitelist:()=>c.setPreLaunchWhitelist($("listAddress").value,value),setPreLaunchWhitelistEnabled:()=>c.setPreLaunchWhitelistEnabled(bool($("preLaunchWhitelistEnabled").value)),setDividendExcluded:()=>c.setDividendExcluded($("listAddress").value,value),setV3Pool:()=>c.setV3Pool($("poolAddress").value,bool($("poolValue").value)),setTaxes:()=>c.setTaxes(bp($("buyTax").value),bp($("sellTax").value)),setTaxWallet:()=>c.setTaxWallet($("taxWallet").value.trim()),setLimits:()=>c.setLimits(token($("maxBuyAmount").value),token($("maxWalletAmount").value)),openTrading:()=>c.openTrading(),pause:()=>c.pause(),unpause:()=>c.unpause(),fundDividends:()=>c.fundDividends({value:token($("dividendAmount").value)}),withdrawETH:()=>c.withdrawETH($("withdrawETHAmount").value?token($("withdrawETHAmount").value):0n),withdrawToken:async()=>{const asset=$("withdrawTokenAddress").value.trim()||address;let amount=0n;if($("withdrawTokenAmount").value)amount=token($("withdrawTokenAmount").value);return c.withdrawToken(asset,amount)} };
  if(!calls[name])throw new Error("未知操作");await done(await calls[name](),name);await refreshAdmin();}
async function run(button,fn){button&&(button.disabled=true);try{await fn()}catch(e){log(`错误：${e.shortMessage||e.reason||e.message||e}`)}finally{button&&(button.disabled=false)}}

document.querySelectorAll(".tab").forEach(b=>b.addEventListener("click",()=>{document.querySelectorAll(".tab,.panel").forEach(x=>x.classList.remove("active"));b.classList.add("active");$(b.dataset.tab).classList.add("active")}));
$("connectWallet").onclick=e=>run(e.currentTarget,connect); $("compileContract").onclick=e=>run(e.currentTarget,compile); $("deployForm").onsubmit=e=>{e.preventDefault();run(e.submitter,()=>deploy(e.target))};
$("loadMint").onclick=e=>run(e.currentTarget,async()=>{state.mint=await at($("mintContractAddress").value.trim());await refreshMint()}); $("mintNow").onclick=e=>run(e.currentTarget,async()=>{if(!state.mint)state.mint=await at($("mintContractAddress").value.trim());await done(await state.mint.mint({value:await state.mint.mintPrice()}),"Mint");await refreshMint()}); $("claimDividend").onclick=e=>run(e.currentTarget,async()=>{if(!state.mint)state.mint=await at($("mintContractAddress").value.trim());await done(await state.mint.claimDividends(),"领取分红");await refreshMint()});
$("loadAdmin").onclick=e=>run(e.currentTarget,async()=>{state.admin=await at($("adminContractAddress").value.trim());await refreshAdmin()}); $("refreshAdmin").onclick=e=>run(e.currentTarget,refreshAdmin); document.querySelectorAll("[data-action]").forEach(b=>b.onclick=()=>run(b,()=>action(b.dataset.action)));
function plan(){const f=$("deployForm").elements,total=Number(f.totalSupply.value||0),per=Number(f.tokenPerMint.value||0),max=Number(f.maxMintCount.value||0),issued=per*max;stats("mintPlan",[["Mint 最大发放",issued.toLocaleString()],["项目方/底池预留",Math.max(0,total-issued).toLocaleString()],["加池方式","项目方手动创建 V3 仓位"]]);} ["totalSupply","tokenPerMint","maxMintCount"].forEach(n=>$("deployForm").elements[n].addEventListener("input",plan));plan();
window.ethereum?.on?.("chainChanged",()=>{state.provider=null;state.signer=null;state.mint=null;state.admin=null;$("walletAddress").textContent="请重新连接"});
