import { ethers } from "https://cdn.jsdelivr.net/npm/ethers@6.13.5/dist/ethers.min.js";

const CONTRACT_SOURCE = String.raw`// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IPancakeRouterV2 {
    function factory() external pure returns (address);
    function WETH() external pure returns (address);
    function addLiquidityETH(address token,uint amountTokenDesired,uint amountTokenMin,uint amountETHMin,address to,uint deadline) external payable returns (uint amountToken, uint amountETH, uint liquidity);
    function addLiquidity(address tokenA,address tokenB,uint amountADesired,uint amountBDesired,uint amountAMin,uint amountBMin,address to,uint deadline) external returns (uint amountA, uint amountB, uint liquidity);
    function swapExactETHForTokensSupportingFeeOnTransferTokens(uint amountOutMin,address[] calldata path,address to,uint deadline) external payable;
    function swapExactTokensForETHSupportingFeeOnTransferTokens(uint amountIn,uint amountOutMin,address[] calldata path,address to,uint deadline) external;
    function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint amountIn,uint amountOutMin,address[] calldata path,address to,uint deadline) external;
}

interface IPancakeFactoryV2 {
    function createPair(address tokenA, address tokenB) external returns (address pair);
}

interface IPancakePairV2 {
    function token0() external view returns (address);
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
}

interface IFairMintDividendDistributor {
    function rewardTokenAddress() external view returns (address);
    function pendingTokenDividend(address user) external view returns (uint256);
    function pendingLPDividend(address user) external view returns (uint256);
    function dividendReserve() external view returns (uint256);
    function minTokenDividendBalance() external view returns (uint256);
    function autoDividendEnabled() external view returns (bool);
    function autoDividendBatchSize() external view returns (uint256);
    function dividendHolderCount() external view returns (uint256);
    function dividendExcludedCount() external view returns (uint256);
    function eligibleTokenDividendSupply() external view returns (uint256);
    function eligibleLPDividendSupply() external view returns (uint256);
    function isExcludedFromDividends(address user) external view returns (bool);
    function claimDividends() external;
    function syncLPDividendDebt() external;
    function syncBefore(address user) external;
    function syncAfter(address user) external;
    function processAutoDividends(uint256 maxCount) external;
    function registerMintLP(address user, uint256 amount, uint256 balanceBefore) external;
    function notifyTokenDividendNative() external payable;
    function notifyTokenDividendToken(uint256 amount) external;
    function notifyLPDividendNative() external payable;
    function notifyLPDividendToken(uint256 amount) external;
}

contract FairMintDividendDistributor is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant ACC = 1e36;

    address public immutable token;
    address public immutable pair;
    address public immutable router;
    address public rewardToken;
    address public deadWallet;
    uint256 public tokenDividendPerShare;
    uint256 public lpDividendPerShare;
    uint256 public dividendReserve;
    uint256 public minTokenDividendBalance;
    mapping(address => bool) private excludedMap;
    mapping(address => bool) private exclusionKnown;
    address[] public dividendExcludedAddresses;
    mapping(address => uint256) public tokenDividendDebt;
    mapping(address => uint256) public tokenDividendCredit;
    mapping(address => uint256) public lpDividendDebt;
    mapping(address => uint256) public lpBalanceSnapshot;
    mapping(address => uint256) public mintLPEntitlement;
    mapping(address => bool) public lpDividendDisqualified;
    uint256 public eligibleMintLPSupply;
    address[] public dividendHolders;
    mapping(address => bool) public isDividendHolder;
    uint256 public dividendProcessIndex;
    bool public autoDividendEnabled = true;
    uint256 public autoDividendBatchSize = 5;

    event TokenDividendFunded(uint256 amount);
    event LPDividendFunded(uint256 amount);
    event DividendClaimed(address indexed user, uint256 tokenReward, uint256 lpReward);
    event AutoDividendProcessed(uint256 processed, uint256 paid);
    event MintLPRegistered(address indexed user, uint256 amount);
    event LPDividendDisqualified(address indexed user, uint256 requiredBalance, uint256 actualBalance);

    modifier onlyToken() {
        require(msg.sender == token, "only token");
        _;
    }

    constructor(
        address token_,
        address pair_,
        address router_,
        address rewardToken_,
        address deadWallet_,
        address owner_,
        uint256 minTokenDividendBalance_
    ) Ownable(owner_) {
        require(token_ != address(0) && pair_ != address(0) && router_ != address(0), "zero addr");
        token = token_;
        pair = pair_;
        router = router_;
        rewardToken = rewardToken_;
        deadWallet = deadWallet_;
        minTokenDividendBalance = minTokenDividendBalance_;
        _setExcludedFromDividends(address(0), true);
        _setExcludedFromDividends(deadWallet_, true);
        _setExcludedFromDividends(address(this), true);
        _setExcludedFromDividends(token_, true);
        _setExcludedFromDividends(pair_, true);
        _setExcludedFromDividends(router_, true);
    }

    function rewardTokenAddress() public view returns (address) { return rewardToken; }
    function isExcludedFromDividends(address user) public view returns (bool) { return excludedMap[user]; }
    function _isNativeReward() internal view returns (bool) { return rewardToken == address(0); }
    function _tokenBalance(address user) internal view returns (uint256) { return IERC20(token).balanceOf(user); }
    function _lpBalance(address user) internal view returns (uint256) { return IERC20(pair).balanceOf(user); }

    function eligibleTokenDividendSupply() public view returns (uint256) {
        uint256 supply = IERC20(token).totalSupply();
        for (uint256 i; i < dividendExcludedAddresses.length; i++) {
            address user = dividendExcludedAddresses[i];
            if (!excludedMap[user]) continue;
            uint256 excludedBalance = IERC20(token).balanceOf(user);
            if (excludedBalance >= supply) return 0;
            supply -= excludedBalance;
        }
        return supply;
    }

    function eligibleLPDividendSupply() public view returns (uint256) { return eligibleMintLPSupply; }

    function dividendExcludedCount() external view returns (uint256) { return dividendExcludedAddresses.length; }
    function dividendHolderCount() external view returns (uint256) { return dividendHolders.length; }
    function syncBefore(address user) external onlyToken { _accrueTokenDividend(user); }
    function syncAfter(address user) external onlyToken { _settleTokenDividend(user); _trackDividendHolder(user); }

    function registerMintLP(address user, uint256 amount, uint256 balanceBefore) external onlyToken {
        if (user == address(0) || amount == 0 || excludedMap[user] || lpDividendDisqualified[user]) return;
        uint256 requiredBalance = mintLPEntitlement[user];
        if (requiredBalance > 0 && balanceBefore < requiredBalance) {
            _disqualifyLP(user, balanceBefore);
            return;
        }
        mintLPEntitlement[user] = requiredBalance + amount;
        eligibleMintLPSupply += amount;
        lpDividendDebt[user] += amount * lpDividendPerShare / ACC;
        lpBalanceSnapshot[user] = _lpBalance(user);
        _trackDividendHolder(user);
        emit MintLPRegistered(user, amount);
    }

    function notifyTokenDividendNative() external payable onlyToken {
        require(_isNativeReward(), "not native reward");
        _fundTokenDividendManual(msg.value);
    }

    function notifyTokenDividendToken(uint256 amount) external onlyToken {
        require(!_isNativeReward(), "native reward");
        _fundTokenDividendManual(amount);
    }

    function notifyLPDividendNative() external payable onlyToken {
        require(_isNativeReward(), "not native reward");
        _fundLPDividendManual(msg.value);
    }

    function notifyLPDividendToken(uint256 amount) external onlyToken {
        require(!_isNativeReward(), "native reward");
        _fundLPDividendManual(amount);
    }

    function fundTokenDividendBNB() external payable onlyOwner {
        require(_isNativeReward(), "not native reward");
        _fundTokenDividendManual(msg.value);
    }

    function fundTokenDividendToken(uint256 amount) public onlyOwner {
        require(!_isNativeReward(), "native reward");
        IERC20(rewardTokenAddress()).safeTransferFrom(msg.sender, address(this), amount);
        _fundTokenDividendManual(amount);
    }

    function fundLPDividendBNB() external payable onlyOwner {
        require(_isNativeReward(), "not native reward");
        _fundLPDividendManual(msg.value);
    }

    function fundLPDividendToken(uint256 amount) public onlyOwner {
        require(!_isNativeReward(), "native reward");
        IERC20(rewardTokenAddress()).safeTransferFrom(msg.sender, address(this), amount);
        _fundLPDividendManual(amount);
    }

    function _fundTokenDividendManual(uint256 amount) internal {
        uint256 circulating = eligibleTokenDividendSupply();
        require(circulating > 0, "no circulating supply");
        dividendReserve += amount;
        tokenDividendPerShare += amount * ACC / circulating;
        emit TokenDividendFunded(amount);
    }

    function _fundLPDividendManual(uint256 amount) internal {
        uint256 lpSupply = eligibleLPDividendSupply();
        require(lpSupply > 0, "no lp supply");
        dividendReserve += amount;
        lpDividendPerShare += amount * ACC / lpSupply;
        emit LPDividendFunded(amount);
    }

    function pendingTokenDividend(address user) public view returns (uint256) {
        if (excludedMap[user]) return 0;
        uint256 pending = tokenDividendCredit[user];
        uint256 balance = _tokenBalance(user);
        if (balance < minTokenDividendBalance) return pending;
        uint256 accumulated = balance * tokenDividendPerShare / ACC;
        if (accumulated > tokenDividendDebt[user]) pending += accumulated - tokenDividendDebt[user];
        return pending;
    }

    function pendingLPDividend(address user) public view returns (uint256) {
        if (excludedMap[user] || lpDividendDisqualified[user]) return 0;
        uint256 entitlement = mintLPEntitlement[user];
        if (entitlement == 0 || _lpBalance(user) < entitlement) return 0;
        uint256 accumulated = entitlement * lpDividendPerShare / ACC;
        if (accumulated <= lpDividendDebt[user]) return 0;
        return accumulated - lpDividendDebt[user];
    }

    function claimDividends() external nonReentrant {
        require(!excludedMap[msg.sender], "dividend excluded");
        _validateLP(msg.sender);
        uint256 tokenReward = pendingTokenDividend(msg.sender);
        uint256 lpReward = pendingLPDividend(msg.sender);
        uint256 reward = tokenReward + lpReward;
        tokenDividendCredit[msg.sender] = 0;
        tokenDividendDebt[msg.sender] = _tokenBalance(msg.sender) * tokenDividendPerShare / ACC;
        lpBalanceSnapshot[msg.sender] = _lpBalance(msg.sender);
        lpDividendDebt[msg.sender] = mintLPEntitlement[msg.sender] * lpDividendPerShare / ACC;
        if (reward > 0) {
            require(dividendReserve >= reward, "dividend reserve");
            dividendReserve -= reward;
            _sendReward(msg.sender, reward);
        }
        emit DividendClaimed(msg.sender, tokenReward, lpReward);
    }

    function syncLPDividendDebt() external {
        _validateLP(msg.sender);
        if (excludedMap[msg.sender]) {
            lpBalanceSnapshot[msg.sender] = 0;
            lpDividendDebt[msg.sender] = 0;
            return;
        }
        lpBalanceSnapshot[msg.sender] = _lpBalance(msg.sender);
        lpDividendDebt[msg.sender] = mintLPEntitlement[msg.sender] * lpDividendPerShare / ACC;
    }

    function _accrueTokenDividend(address user) internal {
        if (user == address(0)) return;
        if (excludedMap[user]) {
            tokenDividendCredit[user] = 0;
            tokenDividendDebt[user] = 0;
            return;
        }
        uint256 pending = pendingTokenDividend(user);
        if (pending > tokenDividendCredit[user]) tokenDividendCredit[user] = pending;
        tokenDividendDebt[user] = _tokenBalance(user) * tokenDividendPerShare / ACC;
    }

    function _settleTokenDividend(address user) internal {
        if (user == address(0)) return;
        tokenDividendDebt[user] = excludedMap[user] ? 0 : _tokenBalance(user) * tokenDividendPerShare / ACC;
    }

    function _trackDividendHolder(address user) internal {
        if (user == address(0) || excludedMap[user] || isDividendHolder[user]) return;
        uint256 bal = _tokenBalance(user);
        if ((bal > 0 && bal >= minTokenDividendBalance) || (mintLPEntitlement[user] > 0 && !lpDividendDisqualified[user])) {
            isDividendHolder[user] = true;
            dividendHolders.push(user);
        }
    }

    function processAutoDividends(uint256 maxCount) external onlyToken {
        if (autoDividendEnabled) _processAutoDividends(maxCount);
    }

    function _processAutoDividends(uint256 maxCount) internal {
        uint256 total = dividendHolders.length;
        if (total == 0 || maxCount == 0 || dividendReserve == 0) return;
        uint256 processed;
        uint256 paid;
        uint256 iterations;
        while (processed < maxCount && iterations < total && dividendReserve > 0) {
            if (dividendProcessIndex >= total) dividendProcessIndex = 0;
            address user = dividendHolders[dividendProcessIndex];
            dividendProcessIndex += 1;
            iterations += 1;
            if (excludedMap[user]) continue;
            _validateLP(user);
            bool tokenEligible = _tokenBalance(user) >= minTokenDividendBalance;
            bool lpEligible = mintLPEntitlement[user] > 0 && !lpDividendDisqualified[user];
            if (!tokenEligible && !lpEligible) continue;
            uint256 tokenReward = pendingTokenDividend(user);
            uint256 lpReward = pendingLPDividend(user);
            uint256 reward = tokenReward + lpReward;
            if (reward == 0 || reward > dividendReserve) continue;
            if (_trySendReward(user, reward)) {
                tokenDividendCredit[user] = 0;
                tokenDividendDebt[user] = _tokenBalance(user) * tokenDividendPerShare / ACC;
                lpBalanceSnapshot[user] = _lpBalance(user);
                lpDividendDebt[user] = mintLPEntitlement[user] * lpDividendPerShare / ACC;
                dividendReserve -= reward;
                paid += reward;
                processed += 1;
                emit DividendClaimed(user, tokenReward, lpReward);
            }
        }
        if (processed > 0) emit AutoDividendProcessed(processed, paid);
    }

    function _sendReward(address to, uint256 amount) internal {
        if (amount == 0) return;
        if (_isNativeReward()) payable(to).transfer(amount);
        else IERC20(rewardTokenAddress()).safeTransfer(to, amount);
    }

    function _trySendReward(address to, uint256 amount) internal returns (bool) {
        if (amount == 0) return true;
        if (_isNativeReward()) { (bool ok,) = payable(to).call{value: amount, gas: 30000}(""); return ok; }
        (bool success, bytes memory data) = rewardTokenAddress().call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        return success && (data.length == 0 || abi.decode(data, (bool)));
    }

    function _isCoreDividendExcluded(address user) internal view returns (bool) {
        return user == address(0) || user == deadWallet || user == address(this) || user == token || user == pair || user == router;
    }

    function _validateLP(address user) internal {
        uint256 requiredBalance = mintLPEntitlement[user];
        if (requiredBalance > 0 && !lpDividendDisqualified[user]) {
            uint256 actualBalance = _lpBalance(user);
            if (actualBalance < requiredBalance) _disqualifyLP(user, actualBalance);
        }
    }

    function _disqualifyLP(address user, uint256 actualBalance) internal {
        if (lpDividendDisqualified[user]) return;
        uint256 requiredBalance = mintLPEntitlement[user];
        lpDividendDisqualified[user] = true;
        if (requiredBalance >= eligibleMintLPSupply) eligibleMintLPSupply = 0;
        else eligibleMintLPSupply -= requiredBalance;
        lpDividendDebt[user] = 0;
        lpBalanceSnapshot[user] = actualBalance;
        emit LPDividendDisqualified(user, requiredBalance, actualBalance);
    }

    function _setExcludedFromDividends(address user, bool v) internal {
        if (excludedMap[user] == v) return;
        if (v) {
            if (mintLPEntitlement[user] > 0) _disqualifyLP(user, _lpBalance(user));
            excludedMap[user] = true;
            tokenDividendCredit[user] = 0;
            tokenDividendDebt[user] = 0;
            lpBalanceSnapshot[user] = 0;
            lpDividendDebt[user] = 0;
            if (!exclusionKnown[user]) { exclusionKnown[user] = true; dividendExcludedAddresses.push(user); }
        } else {
            excludedMap[user] = false;
            tokenDividendDebt[user] = _tokenBalance(user) * tokenDividendPerShare / ACC;
            lpBalanceSnapshot[user] = _lpBalance(user);
            lpDividendDebt[user] = mintLPEntitlement[user] * lpDividendPerShare / ACC;
        }
    }

    function setExcludedFromDividends(address user, bool v) external onlyOwner {
        if (!v) require(!_isCoreDividendExcluded(user), "core dividend exclusion");
        _setExcludedFromDividends(user, v);
    }

    function batchSetExcludedFromDividends(address[] calldata users, bool v) external onlyOwner {
        for (uint256 i; i < users.length; i++) {
            if (!v) require(!_isCoreDividendExcluded(users[i]), "core dividend exclusion");
            _setExcludedFromDividends(users[i], v);
        }
    }

    function setRewardToken(address v) external onlyOwner {
        require(dividendReserve == 0, "reserve not empty");
        require(v != token, "bad reward token");
        rewardToken = v;
    }

    function setMinTokenDividendBalance(uint256 v) external onlyOwner { minTokenDividendBalance = v; }
    function setAutoDividendEnabled(bool v) external onlyOwner { autoDividendEnabled = v; }
    function setAutoDividendBatchSize(uint256 v) external onlyOwner { require(v > 0 && v <= 20, "bad batch"); autoDividendBatchSize = v; }

    function withdrawDividendReserve(uint256 amount) external onlyOwner {
        uint256 toSend = amount == 0 ? dividendReserve : amount;
        require(toSend <= dividendReserve, "exceeds reserve");
        dividendReserve -= toSend;
        _sendReward(owner(), toSend);
    }

    receive() external payable {}
}

contract FairMintTokenV1 is ERC20, Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    enum MintMode { BNB, USDT }
    enum UserMintMode { PERCENT, FIXED }
    enum LaunchMode { MANUAL, TIME, AUTO }
    uint256 public constant DENOMINATOR = 10000;
    uint256 public constant MAX_TAX = 500;
    uint256 public constant MAX_SELL_TAX = 10000;
    MintMode public mintMode;
    LaunchMode public launchMode;
    address public usdtAddress;
    IPancakeRouterV2 public router;
    address public pair;
    uint256 public mintPrice;
    uint256 public tokenPerMint;
    uint256 public maxMintCount;
    uint256 public mintedCount;
    UserMintMode public userMintMode;
    uint256 public userMintShare;
    uint256 public userMintAmount;
    uint256 public lpFundShare;
    uint8 public mintLPRecipientMode;
    uint256 public launchTime;
    uint256 public startTime;
    uint256 public openTime;
    uint256 public tradingStartTime;
    bool public mintEnabled = true;
    bool public tradingOpen;
    bool public liquidityRemovalEnabled;
    mapping(address => bool) public hasMinted;
    bool public whitelistEnabled;
    mapping(address => bool) public whitelist;
    mapping(address => bool) public isExcludedFromLimits;
    mapping(address => bool) public isExcludedFromFee;
    mapping(address => uint256) public boughtAmount;
    bool public buyLimitEnabled;
    uint256 public maxBuyAmountPerWallet;
    mapping(address => uint256) public boughtBaseAmount;
    bool public buyAmountLimitEnabled;
    uint256 public maxBuyBaseAmountPerWallet;
    bool public timedBuyLimitEnabled;
    uint256[3] public timedBuyLimitMinutes;
    uint256[3] public timedBuyLimitAmounts;
    bool public buyWhitelistEnabled;
    mapping(address => bool) public buyWhitelist;
    bool public preLaunchBuyWhitelistEnabled;
    mapping(address => bool) public preLaunchBuyWhitelist;
    uint256 public buyTax;
    uint256 public sellTax;
    uint256 public transferTax;
    uint256 public marketingShare;
    uint256 public burnShare;
    uint256 public lpShare;
    uint256 public dividendShare;
    uint8 public dividendTargetMode;
    address public marketingWallet;
    address public rewardToken;
    address public deadWallet;
    address public dividendDistributor;
    bool public externalDividendDistributorEnabled;
    bool public swapEnabled = true;
    bool private inSwap;
    bool public taxesLocked;
    bool public feeExemptionsLocked;
    bool public pauseDisabledForever;
    uint256 public swapThreshold;
    uint256 public pendingTaxTokens;
    uint256 public tokenDividendPerShare;
    uint256 public lpDividendPerShare;
    uint256 public dividendReserve;
    uint256 public minTokenDividendBalance;
    uint256 private constant ACC = 1e36;
    mapping(address => bool) public isExcludedFromDividends;
    mapping(address => bool) private dividendExclusionKnown;
    address[] public dividendExcludedAddresses;
    uint256 public excludedTokenBalance;
    mapping(address => uint256) public tokenDividendDebt;
    mapping(address => uint256) public tokenDividendCredit;
    mapping(address => uint256) public lpDividendDebt;
    mapping(address => uint256) public lpBalanceSnapshot;
    address[] public dividendHolders;
    mapping(address => bool) public isDividendHolder;
    uint256 public dividendProcessIndex;
    bool public autoDividendEnabled = true;
    uint256 public autoDividendBatchSize = 5;
    event Minted(address indexed user, uint256 paidAmount, uint256 userTokens, uint256 lpTokens, uint256 lpFund);
    event TradingOpened(uint256 timestamp);
    event LiquidityRemovalEnabled(uint256 timestamp);
    event SwapBack(uint256 tokenAmount, uint256 receivedAmount);
    event TokenDividendFunded(uint256 amount);
    event LPDividendFunded(uint256 amount);
    event DividendClaimed(address indexed user, uint256 tokenReward, uint256 lpReward);
    event AutoDividendProcessed(uint256 processed, uint256 paid);
    modifier lockSwap() { inSwap = true; _; inSwap = false; }
    constructor(string memory name_, string memory symbol_, uint256 totalSupply_, MintMode mintMode_, address usdtAddress_, address router_, uint256 mintPrice_, uint256 tokenPerMint_, uint256 maxMintCount_, UserMintMode userMintMode_, uint256 userMintShare_, uint256 userMintAmount_, uint256 lpFundShare_, uint8 mintLPRecipientMode_, LaunchMode launchMode_, uint256 launchTime_, bool mintFeatureEnabled_, address marketingWallet_, address owner_, address rewardToken_, uint8 dividendTargetMode_, uint256 buyTax_, uint256 sellTax_, uint256 transferTax_, uint256 marketingShare_, uint256 burnShare_, uint256 lpShare_, uint256 dividendShare_, bool buyLimitEnabled_, uint256 maxBuyAmountPerWallet_, uint256 minTokenDividendBalance_, bool buyAmountLimitEnabled_, uint256 maxBuyBaseAmountPerWallet_, bool timedBuyLimitEnabled_, uint256[3] memory timedBuyLimitMinutes_, uint256[3] memory timedBuyLimitAmounts_, bool buyWhitelistEnabled_, bool preLaunchBuyWhitelistEnabled_) ERC20(name_, symbol_) Ownable(owner_) {
        require(totalSupply_ > 0, "totalSupply zero");
        require(router_ != address(0), "router zero");
        require(marketingWallet_ != address(0), "marketing zero");
        require(owner_ != address(0), "owner zero");
        require(userMintShare_ <= DENOMINATOR, "bad user share");
        if (userMintMode_ == UserMintMode.FIXED) require(userMintAmount_ <= tokenPerMint_, "bad user amount");
        require(lpFundShare_ <= DENOMINATOR, "bad lp fund share" );
        require(mintLPRecipientMode_ <= 1, "bad lp recipient" );
        require(buyTax_ <= MAX_TAX && transferTax_ <= MAX_TAX, "buy/transfer tax > 5%");
        require(sellTax_ <= MAX_SELL_TAX, "sell tax > 100%");
        require(marketingShare_ + burnShare_ + lpShare_ + dividendShare_ == DENOMINATOR, "sum != 10000");
        require(!(buyLimitEnabled_ && buyAmountLimitEnabled_), "choose one limit");
        require(!(buyAmountLimitEnabled_ && timedBuyLimitEnabled_), "choose one amount limit");
        if (buyLimitEnabled_) require(maxBuyAmountPerWallet_ > 0, "buy limit zero");
        if (buyAmountLimitEnabled_) require(maxBuyBaseAmountPerWallet_ > 0, "buy amount limit zero");
        if (timedBuyLimitEnabled_) require(timedBuyLimitAmounts_[0] > 0, "timed limit zero");
        if (mintMode_ == MintMode.USDT) require(usdtAddress_ != address(0), "usdt zero");
        require(rewardToken_ != address(this), "bad reward token");
        if (launchMode_ == LaunchMode.TIME) require(launchTime_ > block.timestamp, "bad launch time");
        mintMode = mintMode_;
        usdtAddress = usdtAddress_;
        router = IPancakeRouterV2(router_);
        mintPrice = mintPrice_;
        tokenPerMint = tokenPerMint_;
        maxMintCount = maxMintCount_;
        userMintMode = userMintMode_;
        userMintShare = userMintShare_;
        userMintAmount = userMintAmount_;
        lpFundShare = lpFundShare_;
        mintLPRecipientMode = mintLPRecipientMode_;
        launchMode = mintFeatureEnabled_ ? launchMode_ : LaunchMode.MANUAL;
        _setLaunchTime(launchTime_);
        mintEnabled = mintFeatureEnabled_;
        marketingWallet = marketingWallet_;
        rewardToken = rewardToken_;
        buyTax = buyTax_;
        sellTax = sellTax_;
        transferTax = transferTax_;
        marketingShare = marketingShare_;
        burnShare = burnShare_;
        lpShare = lpShare_;
        dividendShare = dividendShare_;
        buyLimitEnabled = buyLimitEnabled_;
        maxBuyAmountPerWallet = maxBuyAmountPerWallet_;
        buyAmountLimitEnabled = buyAmountLimitEnabled_;
        maxBuyBaseAmountPerWallet = maxBuyBaseAmountPerWallet_;
        buyWhitelistEnabled = buyWhitelistEnabled_;
        preLaunchBuyWhitelistEnabled = preLaunchBuyWhitelistEnabled_;
        minTokenDividendBalance = minTokenDividendBalance_;
        deadWallet = 0x000000000000000000000000000000000000dEaD;
        address base = mintMode_ == MintMode.BNB ? router.WETH() : usdtAddress_;
        pair = IPancakeFactoryV2(router.factory()).createPair(address(this), base);
        _mint(mintFeatureEnabled_ ? address(this) : owner_, totalSupply_);
        swapThreshold = totalSupply_ / 1000;
        isExcludedFromLimits[owner_] = true;
        isExcludedFromLimits[address(this)] = true;
        isExcludedFromLimits[router_] = true;
        isExcludedFromFee[owner_] = true;
        isExcludedFromFee[address(this)] = true;
        isExcludedFromFee[router_] = true;
        buyWhitelist[owner_] = true;
        buyWhitelist[address(this)] = true;
        buyWhitelist[router_] = true;
        preLaunchBuyWhitelist[owner_] = true;
        _setExcludedFromDividends(address(0), true);
        _setExcludedFromDividends(deadWallet, true);
        _setExcludedFromDividends(address(this), true);
        _setExcludedFromDividends(pair, true);
        _setExcludedFromDividends(router_, true);
    }
    function dividendMode() external view returns (uint8) { return _useExternalDistributor() ? 1 : 0; }
    function activeDividendContract() external view returns (address) { return _useExternalDistributor() ? dividendDistributor : address(this); }
    function _useExternalDistributor() internal view returns (bool) { return externalDividendDistributorEnabled && dividendDistributor != address(0); }
    function _distributor() internal view returns (IFairMintDividendDistributor) { return IFairMintDividendDistributor(dividendDistributor); }
    receive() external payable nonReentrant whenNotPaused { if (msg.sender == address(router)) return; _mintBNB(msg.sender, msg.value); }
    function decimals() public pure override returns (uint8) { return 18; }
    function mintBNB() external payable nonReentrant whenNotPaused { _mintBNB(msg.sender, msg.value); }
    function _mintBNB(address user, uint256 amount) internal { require(mintMode == MintMode.BNB, "not BNB mode"); require(amount == mintPrice, "bad BNB amount"); _mintFlow(user, amount); }
    function mintUSDT() external nonReentrant whenNotPaused { require(mintMode == MintMode.USDT, "not USDT mode"); IERC20(usdtAddress).safeTransferFrom(msg.sender, address(this), mintPrice); _mintFlow(msg.sender, mintPrice); }
    function _mintFlow(address user, uint256 paidAmount) internal {
        require(mintEnabled, "mint disabled"); require(!hasMinted[user], "already minted"); require(mintedCount < maxMintCount, "mint full"); if (whitelistEnabled) require(whitelist[user], "not whitelisted");
        hasMinted[user] = true; mintedCount += 1;
        uint256 userTokens = userMintMode == UserMintMode.FIXED ? userMintAmount : tokenPerMint * userMintShare / DENOMINATOR;
        uint256 lpTokens = tokenPerMint - userTokens;
        uint256 lpFund = paidAmount * lpFundShare / DENOMINATOR;
        require(balanceOf(address(this)) >= tokenPerMint, "insufficient token reserve");
        if (lpTokens > 0 && lpFund > 0) {
            _approve(address(this), address(router), lpTokens);
            address lpRecipient = mintLPRecipientMode == 1 ? user : owner();
            if (mintMode == MintMode.BNB) router.addLiquidityETH{value: lpFund}(address(this), lpTokens, 0, 0, lpRecipient, block.timestamp);
            else { IERC20(usdtAddress).forceApprove(address(router), lpFund); router.addLiquidity(address(this), usdtAddress, lpTokens, lpFund, 0, 0, lpRecipient, block.timestamp); }
        }
        if (userTokens > 0) _transfer(address(this), user, userTokens);
        emit Minted(user, paidAmount, userTokens, lpTokens, lpFund);
        if (mintedCount >= maxMintCount) { mintEnabled = false; if (launchMode == LaunchMode.AUTO) _openTrading(); }
    }
    function _externalSyncBefore(address user) internal { if (_useExternalDistributor() && user != address(0)) _distributor().syncBefore(user); }
    function _externalSyncAfter(address user) internal { if (_useExternalDistributor() && user != address(0)) _distributor().syncAfter(user); }
    function _update(address from, address to, uint256 amount) internal override {
        if (from == address(0) || to == address(0)) { _updateExcludedTokenBalance(from, to, amount); super._update(from, to, amount); return; }
        if (from == pair && !liquidityRemovalEnabled && _isRemovingLiquidity()) revert("LP removal disabled");
        uint256 grossAmount = amount;
        if (!tradingOpen && launchMode == LaunchMode.TIME && launchTime > 0 && block.timestamp >= launchTime) { tradingOpen = true; tradingStartTime = block.timestamp; emit TradingOpened(block.timestamp); }
        bool exemptLimit = isExcludedFromLimits[from] || isExcludedFromLimits[to];
        bool preLaunchBuy = !tradingOpen && from == pair && preLaunchBuyWhitelistEnabled && preLaunchBuyWhitelist[to];
        if (!tradingOpen && !exemptLimit && !preLaunchBuy) revert("trading not open");
        if (!inSwap && swapEnabled && from != pair && from != address(this)) { uint256 taxTokenBalance = pendingTaxTokens; if (taxTokenBalance >= swapThreshold && swapThreshold > 0) _swapBack(taxTokenBalance); }
        uint256 taxAmount = 0;
        if (!inSwap && !isExcludedFromFee[from] && !isExcludedFromFee[to]) {
            uint256 taxRate; if (from == pair) taxRate = buyTax; else if (to == pair) taxRate = sellTax; else taxRate = transferTax;
            if (taxRate > 0) taxAmount = amount * taxRate / DENOMINATOR;
        }
        if (taxAmount > 0) {
            if (!_useExternalDistributor()) _updateExcludedTokenBalance(from, address(this), taxAmount);
            _externalSyncBefore(from); _externalSyncBefore(address(this));
            super._update(from, address(this), taxAmount);
            _externalSyncAfter(from); _externalSyncAfter(address(this));
            pendingTaxTokens += taxAmount; amount -= taxAmount;
        }
        if (from == pair && buyWhitelistEnabled && !preLaunchBuy) require(buyWhitelist[to], "buy whitelist");
        if (buyLimitEnabled && from == pair && !isExcludedFromLimits[to]) { boughtAmount[to] += amount; require(boughtAmount[to] <= maxBuyAmountPerWallet, "buy limit"); }
        if (buyAmountLimitEnabled && from == pair && !isExcludedFromLimits[to]) { boughtBaseAmount[to] += _baseAmountForBuy(grossAmount); require(boughtBaseAmount[to] <= maxBuyBaseAmountPerWallet, "buy amount limit"); }
        if (timedBuyLimitEnabled && from == pair && !isExcludedFromLimits[to]) { uint256 timedLimit = _currentTimedBuyLimit(); if (timedLimit > 0) { boughtBaseAmount[to] += _baseAmountForBuy(grossAmount); require(boughtBaseAmount[to] <= timedLimit, "time buy limit"); } }
        if (_useExternalDistributor()) {
            _externalSyncBefore(from); _externalSyncBefore(to);
            super._update(from, to, amount);
            _externalSyncAfter(from); _externalSyncAfter(to);
        } else {
            _accrueTokenDividend(from); _accrueTokenDividend(to); _updateExcludedTokenBalance(from, to, amount); super._update(from, to, amount); _settleTokenDividend(from); _settleTokenDividend(to); _trackDividendHolder(from); _trackDividendHolder(to);
        }
        if (!inSwap) _kickAutoDividends();
    }
    function _updateExcludedTokenBalance(address from, address to, uint256 amount) internal {
        if (amount == 0 || from == to) return;
        if (from != address(0) && isExcludedFromDividends[from]) excludedTokenBalance -= amount;
        if (to != address(0) && isExcludedFromDividends[to]) excludedTokenBalance += amount;
    }
    function _baseAmountForBuy(uint256 tokenAmountOut) internal view returns (uint256) {
        IPancakePairV2 mainPair = IPancakePairV2(pair);
        (uint112 reserve0, uint112 reserve1,) = mainPair.getReserves();
        bool tokenIs0 = mainPair.token0() == address(this);
        uint256 reserveOut = tokenIs0 ? uint256(reserve0) : uint256(reserve1);
        uint256 reserveIn = tokenIs0 ? uint256(reserve1) : uint256(reserve0);
        require(tokenAmountOut > 0 && tokenAmountOut < reserveOut, "bad buy amount");
        return reserveIn * tokenAmountOut * 10000 / ((reserveOut - tokenAmountOut) * 9975) + 1;
    }
    function _currentTimedBuyLimit() internal view returns (uint256) {
        if (!timedBuyLimitEnabled || !tradingOpen || tradingStartTime == 0 || block.timestamp < tradingStartTime) return 0;
        uint256 elapsedMinutes = (block.timestamp - tradingStartTime) / 60;
        for (uint256 i; i < 3; i++) {
            uint256 endMinute = timedBuyLimitMinutes[i];
            uint256 limitAmount = timedBuyLimitAmounts[i];
            if (limitAmount == 0) continue;
            if (endMinute == 0 || elapsedMinutes < endMinute) return limitAmount;
        }
        return 0;
    }
    function _isRemovingLiquidity() internal view returns (bool) {
        address base = mintMode == MintMode.BNB ? router.WETH() : usdtAddress;
        (bool reserveOk, bytes memory reserveData) = pair.staticcall(abi.encodeWithSignature("getReserves()"));
        (bool token0Ok, bytes memory token0Data) = pair.staticcall(abi.encodeWithSignature("token0()"));
        if (!reserveOk || !token0Ok || reserveData.length < 96 || token0Data.length < 32) return false;
        (uint112 reserve0, uint112 reserve1,) = abi.decode(reserveData, (uint112, uint112, uint32));
        address token0 = abi.decode(token0Data, (address));
        uint256 baseReserve = token0 == base ? uint256(reserve0) : uint256(reserve1);
        return baseReserve > 0 && IERC20(base).balanceOf(pair) <= baseReserve;
    }
    function _openTrading() internal { if (!tradingOpen) { tradingOpen = true; tradingStartTime = block.timestamp; mintEnabled = false; emit TradingOpened(block.timestamp); } }
    function openTrading() external onlyOwner { _openTrading(); }
    function enableLiquidityRemoval() external onlyOwner { require(tradingOpen, "trading not open"); require(!liquidityRemovalEnabled, "already enabled"); liquidityRemovalEnabled = true; emit LiquidityRemovalEnabled(block.timestamp); }
    function closeMint() external onlyOwner { mintEnabled = false; }
    function _swapBack(uint256 tokenAmount) internal lockSwap {
        uint256 totalShare = marketingShare + burnShare + lpShare + dividendShare; if (totalShare == 0 || tokenAmount == 0) return;
        if (tokenAmount > pendingTaxTokens) tokenAmount = pendingTaxTokens;
        if (tokenAmount == 0) return;
        if (tokenAmount > swapThreshold * 5) tokenAmount = swapThreshold * 5;
        pendingTaxTokens -= tokenAmount;
        uint256 burnTokens = tokenAmount * burnShare / totalShare;
        uint256 lpTokens = tokenAmount * lpShare / totalShare;
        uint256 dividendTokens = tokenAmount * dividendShare / totalShare;
        uint256 marketingTokens = tokenAmount - burnTokens - lpTokens - dividendTokens;
        if (burnTokens > 0) { _updateExcludedTokenBalance(address(this), deadWallet, burnTokens); super._update(address(this), deadWallet, burnTokens); }
        uint256 lpTokenHalf = lpTokens / 2;
        uint256 tokensToSwap = marketingTokens + dividendTokens + lpTokenHalf;
        uint256 received;
        if (tokensToSwap > 0) {
            uint256 beforeBal = _baseBalance(); _approve(address(this), address(router), tokensToSwap);
            if (mintMode == MintMode.BNB) { address[] memory path = new address[](2); path[0] = address(this); path[1] = router.WETH(); router.swapExactTokensForETHSupportingFeeOnTransferTokens(tokensToSwap, 0, path, address(this), block.timestamp); }
            else { address[] memory path = new address[](2); path[0] = address(this); path[1] = usdtAddress; router.swapExactTokensForTokensSupportingFeeOnTransferTokens(tokensToSwap, 0, path, address(this), block.timestamp); }
            received = _baseBalance() - beforeBal;
        }
        if (received > 0) {
            uint256 marketingAmt = received * marketingTokens / tokensToSwap;
            uint256 dividendAmt = received * dividendTokens / tokensToSwap;
            uint256 lpAmt = received - marketingAmt - dividendAmt;
            _sendBase(marketingWallet, marketingAmt);
            if (dividendTargetMode == 1) _fundLPDividendFromSwap(dividendAmt);
            else _fundTokenDividendFromSwap(dividendAmt);
            if (lpAmt > 0 && lpTokenHalf > 0) { _approve(address(this), address(router), lpTokenHalf); if (mintMode == MintMode.BNB) router.addLiquidityETH{value: lpAmt}(address(this), lpTokenHalf, 0, 0, owner(), block.timestamp); else { IERC20(usdtAddress).forceApprove(address(router), lpAmt); router.addLiquidity(address(this), usdtAddress, lpTokenHalf, lpAmt, 0, 0, owner(), block.timestamp); } }
            if (_useExternalDistributor()) _distributor().processAutoDividends(autoDividendBatchSize);
            else if (autoDividendEnabled) _processAutoDividends(autoDividendBatchSize);
        }
        emit SwapBack(tokenAmount, received);
    }
    function forceSwapBack() external onlyOwner { _swapBack(pendingTaxTokens); }
    function forceAddLiquidity(uint256 tokenAmount, uint256 fundAmount) external payable onlyOwner nonReentrant lockSwap { require(tokenAmount > 0 && fundAmount > 0, "zero amount"); _approve(address(this), address(router), tokenAmount); if (mintMode == MintMode.BNB) { require(msg.value == fundAmount, "bad BNB"); router.addLiquidityETH{value: fundAmount}(address(this), tokenAmount, 0, 0, owner(), block.timestamp); } else { IERC20(usdtAddress).safeTransferFrom(msg.sender, address(this), fundAmount); IERC20(usdtAddress).forceApprove(address(router), fundAmount); router.addLiquidity(address(this), usdtAddress, tokenAmount, fundAmount, 0, 0, owner(), block.timestamp); } }
    function rewardTokenAddress() public view returns (address) { if (_useExternalDistributor()) return _distributor().rewardTokenAddress(); return rewardToken == address(0) ? (mintMode == MintMode.BNB ? address(0) : usdtAddress) : rewardToken; }
    function _isNativeReward() internal view returns (bool) { return rewardTokenAddress() == address(0); }
    function _baseToken() internal view returns (address) { return mintMode == MintMode.BNB ? address(0) : usdtAddress; }
    function _baseBalance() internal view returns (uint256) { return mintMode == MintMode.BNB ? address(this).balance : IERC20(usdtAddress).balanceOf(address(this)); }
    function _rewardBalance() internal view returns (uint256) { return _isNativeReward() ? address(this).balance : IERC20(rewardTokenAddress()).balanceOf(address(this)); }
    function _sendBase(address to, uint256 amount) internal { if (amount == 0) return; if (mintMode == MintMode.BNB) payable(to).transfer(amount); else IERC20(usdtAddress).safeTransfer(to, amount); }
    function _sendReward(address to, uint256 amount) internal { if (amount == 0) return; if (_isNativeReward()) payable(to).transfer(amount); else IERC20(rewardTokenAddress()).safeTransfer(to, amount); }
    function _convertBaseToReward(uint256 amount) internal returns (uint256) {
        if (amount == 0) return 0;
        address target = rewardTokenAddress();
        address base = _baseToken();
        if (target == base) return amount;
        uint256 beforeBal = IERC20(target).balanceOf(address(this));
        if (mintMode == MintMode.BNB) { address[] memory path = new address[](2); path[0] = router.WETH(); path[1] = target; router.swapExactETHForTokensSupportingFeeOnTransferTokens{value: amount}(0, path, address(this), block.timestamp); }
        else { IERC20(usdtAddress).forceApprove(address(router), amount); address[] memory path = new address[](3); path[0] = usdtAddress; path[1] = router.WETH(); path[2] = target; router.swapExactTokensForTokensSupportingFeeOnTransferTokens(amount, 0, path, address(this), block.timestamp); }
        return IERC20(target).balanceOf(address(this)) - beforeBal;
    }
    function eligibleTokenDividendSupply() public view returns (uint256) { if (_useExternalDistributor()) return _distributor().eligibleTokenDividendSupply(); return totalSupply() - excludedTokenBalance; }
    function eligibleLPDividendSupply() public view returns (uint256) {
        if (_useExternalDistributor()) return _distributor().eligibleLPDividendSupply();
        uint256 supply = IERC20(pair).totalSupply();
        for (uint256 i; i < dividendExcludedAddresses.length; i++) {
            address user = dividendExcludedAddresses[i];
            if (!isExcludedFromDividends[user]) continue;
            uint256 excludedLP = IERC20(pair).balanceOf(user);
            if (excludedLP >= supply) return 0;
            supply -= excludedLP;
        }
        return supply;
    }
    function dividendExcludedCount() external view returns (uint256) { return _useExternalDistributor() ? _distributor().dividendExcludedCount() : dividendExcludedAddresses.length; }
    function _fundTokenDividendFromSwap(uint256 baseAmount) internal {
        if (baseAmount == 0) return;
        uint256 rewardAmount = _isNativeReward() ? baseAmount : _convertBaseToReward(baseAmount);
        if (_useExternalDistributor()) {
            if (rewardAmount == 0) return;
            if (_isNativeReward()) _distributor().notifyTokenDividendNative{value: rewardAmount}();
            else { IERC20(rewardTokenAddress()).safeTransfer(dividendDistributor, rewardAmount); _distributor().notifyTokenDividendToken(rewardAmount); }
            _kickAutoDividends();
            return;
        }
        uint256 circulating = eligibleTokenDividendSupply(); if (circulating == 0) { _sendReward(marketingWallet, rewardAmount); return; } dividendReserve += rewardAmount; tokenDividendPerShare += rewardAmount * ACC / circulating; emit TokenDividendFunded(rewardAmount); _kickAutoDividends();
    }
    function _fundLPDividendFromSwap(uint256 baseAmount) internal {
        if (baseAmount == 0) return;
        uint256 rewardAmount = _isNativeReward() ? baseAmount : _convertBaseToReward(baseAmount);
        if (_useExternalDistributor()) {
            if (rewardAmount == 0) return;
            if (_isNativeReward()) _distributor().notifyLPDividendNative{value: rewardAmount}();
            else { IERC20(rewardTokenAddress()).safeTransfer(dividendDistributor, rewardAmount); (bool ok,) = dividendDistributor.call(abi.encodeWithSignature("notifyLPDividendToken(uint256)", rewardAmount)); require(ok, "external lp dividend failed"); }
            _kickAutoDividends();
            return;
        }
        uint256 lpSupply = eligibleLPDividendSupply(); if (lpSupply == 0) { _sendReward(marketingWallet, rewardAmount); return; } dividendReserve += rewardAmount; lpDividendPerShare += rewardAmount * ACC / lpSupply; emit LPDividendFunded(rewardAmount); _kickAutoDividends();
    }
    function fundTokenDividendBNB() external payable onlyOwner { require(_isNativeReward(), "not native reward"); if (_useExternalDistributor()) _distributor().notifyTokenDividendNative{value: msg.value}(); else _fundTokenDividendManual(msg.value); _kickAutoDividends(); }
    function fundTokenDividendToken(uint256 amount) public onlyOwner { require(!_isNativeReward(), "native reward"); if (_useExternalDistributor()) { IERC20(rewardTokenAddress()).safeTransferFrom(msg.sender, dividendDistributor, amount); _distributor().notifyTokenDividendToken(amount); } else { IERC20(rewardTokenAddress()).safeTransferFrom(msg.sender, address(this), amount); _fundTokenDividendManual(amount); } _kickAutoDividends(); }
    function fundTokenDividendUSDT(uint256 amount) external onlyOwner { require(rewardTokenAddress() == usdtAddress, "not USDT reward"); fundTokenDividendToken(amount); }
    function _fundTokenDividendManual(uint256 amount) internal { uint256 circulating = eligibleTokenDividendSupply(); require(circulating > 0, "no circulating supply"); dividendReserve += amount; tokenDividendPerShare += amount * ACC / circulating; emit TokenDividendFunded(amount); }
    function fundLPDividendBNB() external payable onlyOwner { require(_isNativeReward(), "not native reward"); if (_useExternalDistributor()) _distributor().notifyLPDividendNative{value: msg.value}(); else _fundLPDividendManual(msg.value); _kickAutoDividends(); }
    function fundLPDividendToken(uint256 amount) public onlyOwner { require(!_isNativeReward(), "native reward"); if (_useExternalDistributor()) { IERC20(rewardTokenAddress()).safeTransferFrom(msg.sender, dividendDistributor, amount); (bool ok,) = dividendDistributor.call(abi.encodeWithSignature("notifyLPDividendToken(uint256)", amount)); require(ok, "external lp fund failed"); } else { IERC20(rewardTokenAddress()).safeTransferFrom(msg.sender, address(this), amount); _fundLPDividendManual(amount); } _kickAutoDividends(); }
    function fundLPDividendUSDT(uint256 amount) external onlyOwner { require(rewardTokenAddress() == usdtAddress, "not USDT reward"); fundLPDividendToken(amount); }
    function _fundLPDividendManual(uint256 amount) internal { uint256 lpSupply = eligibleLPDividendSupply(); require(lpSupply > 0, "no lp supply"); dividendReserve += amount; lpDividendPerShare += amount * ACC / lpSupply; emit LPDividendFunded(amount); }
    function claimDividends() external nonReentrant { if (_useExternalDistributor()) { _distributor().claimDividends(); return; } require(!isExcludedFromDividends[msg.sender], "dividend excluded"); uint256 tokenReward = pendingTokenDividend(msg.sender); uint256 lpReward = pendingLPDividend(msg.sender); uint256 reward = tokenReward + lpReward; tokenDividendCredit[msg.sender] = 0; tokenDividendDebt[msg.sender] = balanceOf(msg.sender) * tokenDividendPerShare / ACC; lpBalanceSnapshot[msg.sender] = IERC20(pair).balanceOf(msg.sender); lpDividendDebt[msg.sender] = lpBalanceSnapshot[msg.sender] * lpDividendPerShare / ACC; if (reward > 0) { require(dividendReserve >= reward, "dividend reserve"); dividendReserve -= reward; _sendReward(msg.sender, reward); } emit DividendClaimed(msg.sender, tokenReward, lpReward); }
    function dividendHolderCount() external view returns (uint256) { return _useExternalDistributor() ? _distributor().dividendHolderCount() : dividendHolders.length; }
    function pendingTokenDividend(address user) public view returns (uint256) { if (_useExternalDistributor()) return _distributor().pendingTokenDividend(user); if (isExcludedFromDividends[user]) return 0; uint256 pending = tokenDividendCredit[user]; if (balanceOf(user) < minTokenDividendBalance) return pending; uint256 accumulated = balanceOf(user) * tokenDividendPerShare / ACC; if (accumulated > tokenDividendDebt[user]) pending += accumulated - tokenDividendDebt[user]; return pending; }
    function pendingLPDividend(address user) public view returns (uint256) { if (_useExternalDistributor()) return _distributor().pendingLPDividend(user); if (isExcludedFromDividends[user]) return 0; uint256 lpBal = IERC20(pair).balanceOf(user); uint256 accumulated = lpBal * lpDividendPerShare / ACC; if (accumulated <= lpDividendDebt[user]) return 0; return accumulated - lpDividendDebt[user]; }
    function syncLPDividendDebt() external { if (_useExternalDistributor()) { _distributor().syncLPDividendDebt(); return; } if (isExcludedFromDividends[msg.sender]) { lpBalanceSnapshot[msg.sender] = 0; lpDividendDebt[msg.sender] = 0; return; } lpBalanceSnapshot[msg.sender] = IERC20(pair).balanceOf(msg.sender); lpDividendDebt[msg.sender] = lpBalanceSnapshot[msg.sender] * lpDividendPerShare / ACC; }
    function _accrueTokenDividend(address user) internal { if (isExcludedFromDividends[user]) { tokenDividendCredit[user] = 0; tokenDividendDebt[user] = 0; return; } uint256 pending = pendingTokenDividend(user); if (pending > tokenDividendCredit[user]) tokenDividendCredit[user] = pending; tokenDividendDebt[user] = balanceOf(user) * tokenDividendPerShare / ACC; }
    function _settleTokenDividend(address user) internal { tokenDividendDebt[user] = isExcludedFromDividends[user] ? 0 : balanceOf(user) * tokenDividendPerShare / ACC; }
    function _trackDividendHolder(address user) internal { if (isExcludedFromDividends[user] || isDividendHolder[user]) return; uint256 bal = balanceOf(user); if (bal > 0 && bal >= minTokenDividendBalance) { isDividendHolder[user] = true; dividendHolders.push(user); } }
    function _kickAutoDividends() internal {
        if (_useExternalDistributor()) _distributor().processAutoDividends(autoDividendBatchSize);
        else if (autoDividendEnabled && dividendReserve > 0) _processAutoDividends(autoDividendBatchSize);
    }
    function _processAutoDividends(uint256 maxCount) internal {
        uint256 total = dividendHolders.length;
        if (total == 0 || maxCount == 0 || dividendReserve == 0) return;
        uint256 processed;
        uint256 paid;
        uint256 iterations;
        while (processed < maxCount && iterations < total && dividendReserve > 0) {
            if (dividendProcessIndex >= total) dividendProcessIndex = 0;
            address user = dividendHolders[dividendProcessIndex];
            dividendProcessIndex += 1;
            iterations += 1;
            if (isExcludedFromDividends[user] || balanceOf(user) < minTokenDividendBalance) continue;
            uint256 tokenReward = pendingTokenDividend(user);
            uint256 lpReward = pendingLPDividend(user);
            uint256 reward = tokenReward + lpReward;
            if (reward == 0 || reward > dividendReserve) continue;
            if (_trySendReward(user, reward)) {
                tokenDividendCredit[user] = 0;
                tokenDividendDebt[user] = balanceOf(user) * tokenDividendPerShare / ACC;
                lpBalanceSnapshot[user] = IERC20(pair).balanceOf(user);
                lpDividendDebt[user] = lpBalanceSnapshot[user] * lpDividendPerShare / ACC;
                dividendReserve -= reward;
                paid += reward;
                processed += 1;
                emit DividendClaimed(user, tokenReward, lpReward);
            }
        }
        if (processed > 0) emit AutoDividendProcessed(processed, paid);
    }
    function _trySendReward(address to, uint256 amount) internal returns (bool) {
        if (amount == 0) return true;
        if (_isNativeReward()) { (bool ok,) = payable(to).call{value: amount, gas: 30000}(""); return ok; }
        (bool success, bytes memory data) = rewardTokenAddress().call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        return success && (data.length == 0 || abi.decode(data, (bool)));
    }
    function processPendingDividends() external { _kickAutoDividends(); }
    function setMintPrice(uint256 v) external onlyOwner { mintPrice = v; }
    function setTokenPerMint(uint256 v) external onlyOwner { if (userMintMode == UserMintMode.FIXED) require(userMintAmount <= v, "bad user amount"); tokenPerMint = v; }
    function setMaxMintCount(uint256 v) external onlyOwner { require(v >= mintedCount, "lt minted"); maxMintCount = v; }
    function setLaunchTime(uint256 v) external onlyOwner { _setLaunchTime(v); }
    function _setLaunchTime(uint256 v) internal { launchTime = v; startTime = v; openTime = v; tradingStartTime = v; }
    function setWhitelistEnabled(bool v) external onlyOwner { whitelistEnabled = v; }
    function setWhitelist(address user, bool v) external onlyOwner { whitelist[user] = v; }
    function batchSetWhitelist(address[] calldata users, bool v) external onlyOwner { for (uint i; i < users.length; i++) whitelist[users[i]] = v; }
    function setExcludedFromFee(address user, bool v) external onlyOwner { require(!feeExemptionsLocked, "fee exemptions locked"); isExcludedFromFee[user] = v; }
    function setBuyLimitEnabled(bool v) external onlyOwner { if (v) { require(maxBuyAmountPerWallet > 0, "buy limit zero"); buyAmountLimitEnabled = false; timedBuyLimitEnabled = false; } buyLimitEnabled = v; }
    function setMaxBuyAmountPerWallet(uint256 v) external onlyOwner { maxBuyAmountPerWallet = v; }
    function setBuyAmountLimitEnabled(bool v) external onlyOwner { if (v) { require(maxBuyBaseAmountPerWallet > 0, "buy amount limit zero"); buyLimitEnabled = false; timedBuyLimitEnabled = false; } buyAmountLimitEnabled = v; }
    function setMaxBuyBaseAmountPerWallet(uint256 v) external onlyOwner { maxBuyBaseAmountPerWallet = v; }
    function setTimedBuyLimitEnabled(bool v) external onlyOwner { if (v) { require(timedBuyLimitAmounts[0] > 0, "timed limit zero"); buyLimitEnabled = false; buyAmountLimitEnabled = false; } timedBuyLimitEnabled = v; }
    function setTimedBuyLimitTier(uint256 index, uint256 endMinute, uint256 amount) external onlyOwner { require(index < 3, "bad tier"); if (index > 0 && timedBuyLimitMinutes[index - 1] > 0 && endMinute > 0) require(endMinute > timedBuyLimitMinutes[index - 1], "bad minute"); if (index < 2 && timedBuyLimitMinutes[index + 1] > 0 && endMinute > 0) require(endMinute < timedBuyLimitMinutes[index + 1], "bad minute"); timedBuyLimitMinutes[index] = endMinute; timedBuyLimitAmounts[index] = amount; }
    function setBuyWhitelistEnabled(bool v) external onlyOwner { buyWhitelistEnabled = v; }
    function setBuyWhitelist(address user, bool v) external onlyOwner { require(user != address(0), "zero address"); buyWhitelist[user] = v; }
    function batchSetBuyWhitelist(address[] calldata users, bool v) external onlyOwner { for (uint i; i < users.length; i++) { require(users[i] != address(0), "zero address"); buyWhitelist[users[i]] = v; } }
    function setPreLaunchBuyWhitelistEnabled(bool v) external onlyOwner { preLaunchBuyWhitelistEnabled = v; }
    function setPreLaunchBuyWhitelist(address user, bool v) external onlyOwner { require(user != address(0), "zero address"); preLaunchBuyWhitelist[user] = v; }
    function batchSetPreLaunchBuyWhitelist(address[] calldata users, bool v) external onlyOwner { for (uint i; i < users.length; i++) { require(users[i] != address(0), "zero address"); preLaunchBuyWhitelist[users[i]] = v; } }
    function _isCoreDividendExcluded(address user) internal view returns (bool) { return user == address(0) || user == deadWallet || user == address(this) || user == pair || user == address(router); }
    function _setExcludedFromDividends(address user, bool v) internal {
        if (isExcludedFromDividends[user] == v) return;
        if (v) {
            isExcludedFromDividends[user] = true;
            excludedTokenBalance += balanceOf(user);
            tokenDividendCredit[user] = 0;
            tokenDividendDebt[user] = 0;
            lpBalanceSnapshot[user] = 0;
            lpDividendDebt[user] = 0;
            if (!dividendExclusionKnown[user]) { dividendExclusionKnown[user] = true; dividendExcludedAddresses.push(user); }
        } else {
            isExcludedFromDividends[user] = false;
            excludedTokenBalance -= balanceOf(user);
            tokenDividendDebt[user] = balanceOf(user) * tokenDividendPerShare / ACC;
            lpBalanceSnapshot[user] = IERC20(pair).balanceOf(user);
            lpDividendDebt[user] = mintLPEntitlement[user] * lpDividendPerShare / ACC;
        }
    }
    function setExcludedFromDividends(address user, bool v) external onlyOwner { if (!v) require(!_isCoreDividendExcluded(user), "core dividend exclusion"); _setExcludedFromDividends(user, v); }
    function batchSetExcludedFromDividends(address[] calldata users, bool v) external onlyOwner { for (uint256 i; i < users.length; i++) { if (!v) require(!_isCoreDividendExcluded(users[i]), "core dividend exclusion"); _setExcludedFromDividends(users[i], v); } }
    function dividendReserveView() external view returns (uint256) { return _useExternalDistributor() ? _distributor().dividendReserve() : dividendReserve; }
    function isDividendExcluded(address user) external view returns (bool) { return _useExternalDistributor() ? _distributor().isExcludedFromDividends(user) : isExcludedFromDividends[user]; }
    function minTokenDividendBalanceView() external view returns (uint256) { return _useExternalDistributor() ? _distributor().minTokenDividendBalance() : minTokenDividendBalance; }
    function autoDividendEnabledView() external view returns (bool) { return _useExternalDistributor() ? _distributor().autoDividendEnabled() : autoDividendEnabled; }
    function autoDividendBatchSizeView() external view returns (uint256) { return _useExternalDistributor() ? _distributor().autoDividendBatchSize() : autoDividendBatchSize; }
    function setMinTokenDividendBalance(uint256 v) external onlyOwner { if (_useExternalDistributor()) revert("use distributor"); minTokenDividendBalance = v; }
    function setAutoDividendEnabled(bool v) external onlyOwner { if (_useExternalDistributor()) revert("use distributor"); autoDividendEnabled = v; }
    function setAutoDividendBatchSize(uint256 v) external onlyOwner { if (_useExternalDistributor()) revert("use distributor"); require(v > 0 && v <= 20, "bad batch"); autoDividendBatchSize = v; }
    function lockTaxes() external onlyOwner { taxesLocked = true; }
    function lockFeeExemptions() external onlyOwner { feeExemptionsLocked = true; }
    function disablePauseForever() external onlyOwner { pauseDisabledForever = true; }
    function setBuyTax(uint256 v) external onlyOwner { require(!taxesLocked, "taxes locked"); require(v <= MAX_TAX, "tax > 5%"); buyTax = v; }
    function setSellTax(uint256 v) external onlyOwner { require(!taxesLocked, "taxes locked"); require(v <= MAX_SELL_TAX, "sell tax > 100%"); sellTax = v; }
    function setTransferTax(uint256 v) external onlyOwner { require(!taxesLocked, "taxes locked"); require(v <= MAX_TAX, "tax > 5%"); transferTax = v; }
    function setTaxShares(uint256 marketing, uint256 burn, uint256 lp, uint256 dividend) external onlyOwner { require(!taxesLocked, "taxes locked"); require(marketing + burn + lp + dividend == DENOMINATOR, "sum != 10000"); marketingShare = marketing; burnShare = burn; lpShare = lp; dividendShare = dividend; }
    function setDividendTargetMode(uint8 v) external onlyOwner { require(v <= 1, "bad dividend target"); dividendTargetMode = v; }
    function setMarketingShare(uint256 v) external onlyOwner { require(!taxesLocked, "taxes locked"); marketingShare = v; _checkShares(); }
    function setBurnShare(uint256 v) external onlyOwner { require(!taxesLocked, "taxes locked"); burnShare = v; _checkShares(); }
    function setLPShare(uint256 v) external onlyOwner { require(!taxesLocked, "taxes locked"); lpShare = v; _checkShares(); }
    function setDividendShare(uint256 v) external onlyOwner { require(!taxesLocked, "taxes locked"); dividendShare = v; _checkShares(); }
    function _checkShares() internal view { require(marketingShare + burnShare + lpShare + dividendShare == DENOMINATOR, "sum != 10000"); }
    function setMarketingWallet(address v) external onlyOwner { require(v != address(0), "zero"); marketingWallet = v; }
    function setRewardToken(address v) external onlyOwner { require(!_useExternalDistributor(), "use distributor"); require(dividendReserve == 0, "reserve not empty"); require(v != address(this), "bad reward token"); rewardToken = v; }
    function setDividendDistributor(address distributor, bool enabled) external onlyOwner {
        if (enabled) require(distributor != address(0), "distributor zero");
        dividendDistributor = distributor;
        externalDividendDistributorEnabled = enabled && distributor != address(0);
    }
    function setDeadWallet(address v) external onlyOwner { require(v != address(0), "zero"); deadWallet = v; }
    function setSwapEnabled(bool v) external onlyOwner { swapEnabled = v; }
    function setSwapThreshold(uint256 v) external onlyOwner { swapThreshold = v; }
    function pause() external onlyOwner { require(!pauseDisabledForever, "pause disabled"); require(!tradingOpen, "trading open"); _pause(); }
    function unpause() external onlyOwner { _unpause(); }
    function withdrawBNB(uint256 amount) external onlyOwner { uint256 bal = address(this).balance; uint256 locked = _isNativeReward() ? dividendReserve : 0; require(bal > locked, "no available BNB"); uint256 available = bal - locked; uint256 toSend = amount == 0 ? available : amount; require(toSend <= available, "exceeds available"); payable(owner()).transfer(toSend); }
    function withdrawToken(address token, uint256 amount) external onlyOwner { IERC20 erc = IERC20(token); uint256 bal = erc.balanceOf(address(this)); uint256 locked = (!_isNativeReward() && token == rewardTokenAddress()) ? dividendReserve : 0; require(bal > locked, "no available token"); uint256 available = bal - locked; uint256 toSend = amount == 0 ? available : amount; require(toSend <= available, "exceeds available"); erc.safeTransfer(owner(), toSend); }
    function withdrawDividendReserve(uint256 amount) external onlyOwner { require(!_useExternalDistributor(), "use distributor"); uint256 toSend = amount == 0 ? dividendReserve : amount; require(toSend <= dividendReserve, "exceeds reserve"); dividendReserve -= toSend; _sendReward(owner(), toSend); }
    function withdrawLP(uint256 amount) external onlyOwner { IERC20 lpToken = IERC20(pair); uint256 bal = lpToken.balanceOf(address(this)); lpToken.safeTransfer(owner(), amount == 0 ? bal : amount); }
}`;

const FACTORY_SOURCE = String.raw`// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract Create2Factory {
    event Deployed(address indexed deployed, bytes32 indexed salt);

    function deploy(bytes32 salt, bytes memory bytecode) external payable returns (address deployed) {
        require(bytecode.length != 0, "bytecode empty");
        assembly {
            deployed := create2(callvalue(), add(bytecode, 0x20), mload(bytecode), salt)
        }
        require(deployed != address(0), "create2 failed");
        emit Deployed(deployed, salt);
    }

    function computeAddress(bytes32 salt, bytes32 initCodeHash) external view returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash)))));
    }
}`;

const LITE_CONTRACT_SOURCE = String.raw`// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IPancakeRouterV2Lite {
    function factory() external pure returns (address);
    function WETH() external pure returns (address);
    function addLiquidityETH(address token,uint amountTokenDesired,uint amountTokenMin,uint amountETHMin,address to,uint deadline) external payable returns (uint amountToken, uint amountETH, uint liquidity);
    function addLiquidity(address tokenA,address tokenB,uint amountADesired,uint amountBDesired,uint amountAMin,uint amountBMin,address to,uint deadline) external returns (uint amountA, uint amountB, uint liquidity);
    function swapExactETHForTokensSupportingFeeOnTransferTokens(uint amountOutMin,address[] calldata path,address to,uint deadline) external payable;
    function swapExactTokensForETHSupportingFeeOnTransferTokens(uint amountIn,uint amountOutMin,address[] calldata path,address to,uint deadline) external;
    function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint amountIn,uint amountOutMin,address[] calldata path,address to,uint deadline) external;
}

interface IPancakeFactoryV2Lite {
    function createPair(address tokenA, address tokenB) external returns (address pair);
}

interface IPancakePairV2Lite {
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function token0() external view returns (address);
}

contract FairMintTokenV1 is ERC20, Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum MintMode { BNB, USDT }
    enum UserMintMode { PERCENT, FIXED }
    enum LaunchMode { MANUAL, TIME, AUTO }

    uint256 public constant DENOMINATOR = 10000;
    uint256 public constant MAX_TAX = 500;
    uint256 public constant MAX_SELL_TAX = 10000;

    MintMode public mintMode;
    LaunchMode public launchMode;
    address public usdtAddress;
    IPancakeRouterV2Lite public router;
    address public pair;
    uint256 public mintPrice;
    uint256 public tokenPerMint;
    uint256 public maxMintCount;
    uint256 public mintedCount;
    UserMintMode public userMintMode;
    uint256 public userMintShare;
    uint256 public userMintAmount;
    uint256 public lpFundShare;
    uint8 public mintLPRecipientMode;
    uint256 public launchTime;
    uint256 public startTime;
    uint256 public openTime;
    uint256 public tradingStartTime;
    bool public mintEnabled = true;
    bool public tradingOpen;
    bool public liquidityRemovalEnabled;
    mapping(address => bool) public hasMinted;
    bool public whitelistEnabled;
    mapping(address => bool) public whitelist;
    mapping(address => bool) public isExcludedFromLimits;
    mapping(address => bool) public isExcludedFromFee;
    uint256 public buyTax;
    uint256 public sellTax;
    uint256 public transferTax;
    uint256 public marketingShare;
    uint256 public burnShare;
    uint256 public lpShare;
    uint256 public dividendShare;
    uint8 public dividendTargetMode;
    address public marketingWallet;
    address public rewardToken;
    address public deadWallet;
    bool public swapEnabled = true;
    bool private inSwap;
    bool public taxesLocked;
    bool public feeExemptionsLocked;
    bool public pauseDisabledForever;
    uint256 public swapThreshold;
    uint256 public pendingTaxTokens;
    bool public buyLimitEnabled;
    uint256 public maxBuyAmountPerWallet;
    bool public buyAmountLimitEnabled;
    uint256 public maxBuyBaseAmountPerWallet;
    bool public timedBuyLimitEnabled;
    uint256[3] public timedBuyLimitMinutes;
    uint256[3] public timedBuyLimitAmounts;
    mapping(address => uint256) public boughtAmount;
    mapping(address => uint256) public boughtBaseAmount;
    bool public buyWhitelistEnabled;
    mapping(address => bool) public buyWhitelist;
    bool public preLaunchBuyWhitelistEnabled;
    mapping(address => bool) public preLaunchBuyWhitelist;
    bool public autoDividendEnabled;
    uint256 public autoDividendBatchSize;
    uint256 public minTokenDividendBalance;
    address public dividendDistributor;
    bool public externalDividendDistributorEnabled;

    event Minted(address indexed user, uint256 paidAmount, uint256 userTokens, uint256 lpTokens, uint256 lpFund);
    event TradingOpened(uint256 timestamp);
    event LiquidityRemovalEnabled(uint256 timestamp);
    event SwapBack(uint256 tokenAmount, uint256 receivedAmount);

    modifier lockSwap() { inSwap = true; _; inSwap = false; }

    constructor(
        string memory name_,
        string memory symbol_,
        uint256 totalSupply_,
        MintMode mintMode_,
        address usdtAddress_,
        address router_,
        uint256 mintPrice_,
        uint256 tokenPerMint_,
        uint256 maxMintCount_,
        UserMintMode userMintMode_,
        uint256 userMintShare_,
        uint256 userMintAmount_,
        uint256 lpFundShare_,
        uint8 mintLPRecipientMode_,
        LaunchMode launchMode_,
        uint256 launchTime_,
        bool mintFeatureEnabled_,
        address marketingWallet_,
        address owner_,
        address rewardToken_,
        uint8 dividendTargetMode_,
        uint256 buyTax_,
        uint256 sellTax_,
        uint256 transferTax_,
        uint256 marketingShare_,
        uint256 burnShare_,
        uint256 lpShare_,
        uint256 dividendShare_,
        bool buyLimitEnabled_,
        uint256 maxBuyAmountPerWallet_,
        uint256 minTokenDividendBalance_,
        bool buyAmountLimitEnabled_,
        uint256 maxBuyBaseAmountPerWallet_,
        bool timedBuyLimitEnabled_,
        uint256[3] memory timedBuyLimitMinutes_,
        uint256[3] memory timedBuyLimitAmounts_,
        bool buyWhitelistEnabled_,
        bool preLaunchBuyWhitelistEnabled_
    ) ERC20(name_, symbol_) Ownable(owner_) {
        require(totalSupply_ > 0, "totalSupply zero");
        require(router_ != address(0), "router zero");
        require(marketingWallet_ != address(0), "marketing zero");
        require(owner_ != address(0), "owner zero");
        require(userMintShare_ <= DENOMINATOR, "bad user share");
        if (userMintMode_ == UserMintMode.FIXED) require(userMintAmount_ <= tokenPerMint_, "bad user amount");
        require(lpFundShare_ <= DENOMINATOR, "bad lp fund share" );
        require(mintLPRecipientMode_ <= 1, "bad lp recipient" );
        require(buyTax_ <= MAX_TAX && transferTax_ <= MAX_TAX, "buy/transfer tax > 5%");
        require(sellTax_ <= MAX_SELL_TAX, "sell tax > 100%");
        require(marketingShare_ + burnShare_ + lpShare_ + dividendShare_ == DENOMINATOR, "sum != 10000");
        require(dividendTargetMode_ <= 1, "bad dividend target");
        if (mintMode_ == MintMode.USDT) require(usdtAddress_ != address(0), "usdt zero");
        if (launchMode_ == LaunchMode.TIME) require(launchTime_ > block.timestamp, "bad launch time");
        mintMode = mintMode_;
        usdtAddress = usdtAddress_;
        router = IPancakeRouterV2Lite(router_);
        mintPrice = mintPrice_;
        tokenPerMint = tokenPerMint_;
        maxMintCount = maxMintCount_;
        userMintMode = userMintMode_;
        userMintShare = userMintShare_;
        userMintAmount = userMintAmount_;
        lpFundShare = lpFundShare_;
        mintLPRecipientMode = mintLPRecipientMode_;
        launchMode = mintFeatureEnabled_ ? launchMode_ : LaunchMode.MANUAL;
        launchTime = launchTime_;
        startTime = launchTime_;
        openTime = launchTime_;
        tradingStartTime = launchTime_;
        mintEnabled = mintFeatureEnabled_;
        marketingWallet = marketingWallet_;
        rewardToken = rewardToken_;
        dividendTargetMode = dividendTargetMode_;
        buyTax = buyTax_;
        sellTax = sellTax_;
        transferTax = transferTax_;
        marketingShare = marketingShare_;
        burnShare = burnShare_;
        lpShare = lpShare_;
        dividendShare = dividendShare_;
        if (buyLimitEnabled_) { buyAmountLimitEnabled_ = false; timedBuyLimitEnabled_ = false; }
        if (buyAmountLimitEnabled_) { buyLimitEnabled_ = false; timedBuyLimitEnabled_ = false; }
        if (timedBuyLimitEnabled_) { buyLimitEnabled_ = false; buyAmountLimitEnabled_ = false; }
        buyLimitEnabled = buyLimitEnabled_;
        maxBuyAmountPerWallet = maxBuyAmountPerWallet_;
        buyAmountLimitEnabled = buyAmountLimitEnabled_;
        maxBuyBaseAmountPerWallet = maxBuyBaseAmountPerWallet_;
        timedBuyLimitEnabled = timedBuyLimitEnabled_;
        timedBuyLimitMinutes = timedBuyLimitMinutes_;
        timedBuyLimitAmounts = timedBuyLimitAmounts_;
        buyWhitelistEnabled = buyWhitelistEnabled_;
        preLaunchBuyWhitelistEnabled = preLaunchBuyWhitelistEnabled_;
        minTokenDividendBalance = minTokenDividendBalance_;
        autoDividendBatchSize = 5;
        deadWallet = 0x000000000000000000000000000000000000dEaD;
        address base = mintMode_ == MintMode.BNB ? router.WETH() : usdtAddress_;
        pair = IPancakeFactoryV2Lite(router.factory()).createPair(address(this), base);
        _mint(mintFeatureEnabled_ ? address(this) : owner_, totalSupply_);
        swapThreshold = totalSupply_ / 1000;
        isExcludedFromLimits[owner_] = true;
        isExcludedFromLimits[address(this)] = true;
        isExcludedFromLimits[router_] = true;
        isExcludedFromFee[owner_] = true;
        isExcludedFromFee[address(this)] = true;
        isExcludedFromFee[router_] = true;
        buyWhitelist[owner_] = true;
        buyWhitelist[address(this)] = true;
        buyWhitelist[router_] = true;
        preLaunchBuyWhitelist[owner_] = true;
    }

    receive() external payable nonReentrant whenNotPaused { if (msg.sender == address(router)) return; _mintBNB(msg.sender, msg.value); }
    function decimals() public pure override returns (uint8) { return 18; }
    function dividendMode() external pure returns (uint8) { return 0; }
    function activeDividendContract() external view returns (address) { return address(this); }
    function rewardTokenAddress() public view returns (address) { return rewardToken == address(0) ? (mintMode == MintMode.BNB ? address(0) : usdtAddress) : rewardToken; }
    function dividendReserveView() external pure returns (uint256) { return 0; }
    function minTokenDividendBalanceView() external view returns (uint256) { return minTokenDividendBalance; }
    function autoDividendEnabledView() external view returns (bool) { return autoDividendEnabled; }
    function autoDividendBatchSizeView() external view returns (uint256) { return autoDividendBatchSize; }
    function processPendingDividends() external pure {}
    function isDividendExcluded(address) external pure returns (bool) { return false; }
    function dividendExcludedCount() external pure returns (uint256) { return 0; }
    function dividendHolderCount() external pure returns (uint256) { return 0; }
    function eligibleTokenDividendSupply() public view returns (uint256) { return totalSupply(); }
    function eligibleLPDividendSupply() public pure returns (uint256) { return 0; }
    function pendingTokenDividend(address) public pure returns (uint256) { return 0; }
    function pendingLPDividend(address) public pure returns (uint256) { return 0; }
    function claimDividends() external pure { revert("dividend disabled"); }
    function syncLPDividendDebt() external pure {}
    function setDividendDistributor(address distributor, bool enabled) external onlyOwner { dividendDistributor = distributor; externalDividendDistributorEnabled = enabled && distributor != address(0); }
    function setExcludedFromDividends(address, bool) external pure {}
    function batchSetExcludedFromDividends(address[] calldata, bool) external pure {}
    function setMinTokenDividendBalance(uint256 v) external onlyOwner { minTokenDividendBalance = v; }
    function setAutoDividendEnabled(bool v) external onlyOwner { autoDividendEnabled = v; }
    function setAutoDividendBatchSize(uint256 v) external onlyOwner { autoDividendBatchSize = v; }
    function fundTokenDividendBNB() external payable onlyOwner {}
    function fundTokenDividendToken(uint256) public pure {}
    function fundTokenDividendUSDT(uint256) external pure {}
    function fundLPDividendBNB() external payable onlyOwner {}
    function fundLPDividendToken(uint256) public pure {}
    function fundLPDividendUSDT(uint256) external pure {}
    function withdrawDividendReserve(uint256) external pure {}
    function setRewardToken(address v) external onlyOwner { rewardToken = v; }
    function setDividendTargetMode(uint8 v) external onlyOwner { dividendTargetMode = v; }

    function mintBNB() external payable nonReentrant whenNotPaused { _mintBNB(msg.sender, msg.value); }
    function _mintBNB(address user, uint256 amount) internal { require(mintMode == MintMode.BNB, "not BNB mode"); require(amount == mintPrice, "bad BNB amount"); _mintFlow(user, amount); }
    function mintUSDT() external nonReentrant whenNotPaused { require(mintMode == MintMode.USDT, "not USDT mode"); IERC20(usdtAddress).safeTransferFrom(msg.sender, address(this), mintPrice); _mintFlow(msg.sender, mintPrice); }

    function _mintFlow(address user, uint256 paidAmount) internal {
        require(mintEnabled, "mint disabled");
        require(!hasMinted[user], "already minted");
        require(mintedCount < maxMintCount, "mint full");
        if (whitelistEnabled) require(whitelist[user], "not whitelisted");
        hasMinted[user] = true;
        mintedCount += 1;
        uint256 userTokens = userMintMode == UserMintMode.FIXED ? userMintAmount : tokenPerMint * userMintShare / DENOMINATOR;
        uint256 lpTokens = tokenPerMint - userTokens;
        uint256 lpFund = paidAmount * lpFundShare / DENOMINATOR;
        require(balanceOf(address(this)) >= tokenPerMint, "insufficient token reserve");
        if (lpTokens > 0 && lpFund > 0) {
            _approve(address(this), address(router), lpTokens);
            address lpRecipient = mintLPRecipientMode == 1 ? user : owner();
            if (mintMode == MintMode.BNB) router.addLiquidityETH{value: lpFund}(address(this), lpTokens, 0, 0, lpRecipient, block.timestamp);
            else {
                IERC20(usdtAddress).forceApprove(address(router), lpFund);
                router.addLiquidity(address(this), usdtAddress, lpTokens, lpFund, 0, 0, lpRecipient, block.timestamp);
            }
        }
        if (userTokens > 0) _transfer(address(this), user, userTokens);
        emit Minted(user, paidAmount, userTokens, lpTokens, lpFund);
        if (mintedCount >= maxMintCount) { mintEnabled = false; if (launchMode == LaunchMode.AUTO) _openTrading(); }
    }

    function _update(address from, address to, uint256 amount) internal override {
        if (from == address(0) || to == address(0)) { super._update(from, to, amount); return; }
        if (from == pair && !liquidityRemovalEnabled && _isRemovingLiquidity()) revert("LP removal disabled");
        uint256 grossAmount = amount;
        if (!tradingOpen && launchMode == LaunchMode.TIME && launchTime > 0 && block.timestamp >= launchTime) { tradingOpen = true; tradingStartTime = block.timestamp; emit TradingOpened(block.timestamp); }
        bool exemptLimit = isExcludedFromLimits[from] || isExcludedFromLimits[to];
        bool preLaunchBuy = !tradingOpen && from == pair && preLaunchBuyWhitelistEnabled && preLaunchBuyWhitelist[to];
        if (!tradingOpen && !exemptLimit && !preLaunchBuy) revert("trading not open");
        if (!inSwap && swapEnabled && from != pair && from != address(this)) {
            uint256 taxTokenBalance = pendingTaxTokens;
            if (taxTokenBalance >= swapThreshold && swapThreshold > 0) _swapBack(taxTokenBalance);
        }
        uint256 taxAmount = 0;
        if (!inSwap && !isExcludedFromFee[from] && !isExcludedFromFee[to]) {
            uint256 taxRate;
            if (from == pair) taxRate = buyTax;
            else if (to == pair) taxRate = sellTax;
            else taxRate = transferTax;
            if (taxRate > 0) taxAmount = amount * taxRate / DENOMINATOR;
        }
        if (taxAmount > 0) {
            super._update(from, address(this), taxAmount);
            pendingTaxTokens += taxAmount;
            amount -= taxAmount;
        }
        if (from == pair && buyWhitelistEnabled && !preLaunchBuy) require(buyWhitelist[to], "buy whitelist");
        if (buyLimitEnabled && from == pair && !isExcludedFromLimits[to]) { boughtAmount[to] += amount; require(boughtAmount[to] <= maxBuyAmountPerWallet, "buy limit"); }
        if (buyAmountLimitEnabled && from == pair && !isExcludedFromLimits[to]) { boughtBaseAmount[to] += _baseAmountForBuy(grossAmount); require(boughtBaseAmount[to] <= maxBuyBaseAmountPerWallet, "buy amount limit"); }
        if (timedBuyLimitEnabled && from == pair && !isExcludedFromLimits[to]) { uint256 timedLimit = _currentTimedBuyLimit(); if (timedLimit > 0) { boughtBaseAmount[to] += _baseAmountForBuy(grossAmount); require(boughtBaseAmount[to] <= timedLimit, "time buy limit"); } }
        super._update(from, to, amount);
    }

    function _baseAmountForBuy(uint256 tokenAmountOut) internal view returns (uint256) {
        IPancakePairV2Lite mainPair = IPancakePairV2Lite(pair);
        (uint112 reserve0, uint112 reserve1,) = mainPair.getReserves();
        bool tokenIs0 = mainPair.token0() == address(this);
        uint256 reserveOut = tokenIs0 ? uint256(reserve0) : uint256(reserve1);
        uint256 reserveIn = tokenIs0 ? uint256(reserve1) : uint256(reserve0);
        require(tokenAmountOut > 0 && tokenAmountOut < reserveOut, "bad buy amount");
        return reserveIn * tokenAmountOut * 10000 / ((reserveOut - tokenAmountOut) * 9975) + 1;
    }
    function _currentTimedBuyLimit() internal view returns (uint256) {
        if (!timedBuyLimitEnabled || !tradingOpen || tradingStartTime == 0 || block.timestamp < tradingStartTime) return 0;
        uint256 elapsedMinutes = (block.timestamp - tradingStartTime) / 60;
        for (uint256 i; i < 3; i++) {
            uint256 endMinute = timedBuyLimitMinutes[i];
            uint256 limitAmount = timedBuyLimitAmounts[i];
            if (limitAmount == 0) continue;
            if (endMinute == 0 || elapsedMinutes < endMinute) return limitAmount;
        }
        return 0;
    }

    function _baseBalance() internal view returns (uint256) { return mintMode == MintMode.BNB ? address(this).balance : IERC20(usdtAddress).balanceOf(address(this)); }
    function _sendBase(address to, uint256 amount) internal { if (amount == 0) return; if (mintMode == MintMode.BNB) payable(to).transfer(amount); else IERC20(usdtAddress).safeTransfer(to, amount); }

    function _swapBack(uint256 tokenAmount) internal lockSwap {
        uint256 totalShare = marketingShare + burnShare + lpShare + dividendShare;
        if (totalShare == 0 || tokenAmount == 0) return;
        if (tokenAmount > pendingTaxTokens) tokenAmount = pendingTaxTokens;
        if (tokenAmount == 0) return;
        pendingTaxTokens -= tokenAmount;
        uint256 burnTokens = tokenAmount * burnShare / totalShare;
        uint256 lpTokens = tokenAmount * lpShare / totalShare;
        uint256 dividendTokens = tokenAmount * dividendShare / totalShare;
        uint256 marketingTokens = tokenAmount - burnTokens - lpTokens - dividendTokens;
        if (burnTokens > 0) super._update(address(this), deadWallet, burnTokens);
        uint256 lpTokenHalf = lpTokens / 2;
        uint256 tokensToSwap = marketingTokens + dividendTokens + lpTokenHalf;
        uint256 received;
        if (tokensToSwap > 0) {
            uint256 beforeBal = _baseBalance();
            _approve(address(this), address(router), tokensToSwap);
            if (mintMode == MintMode.BNB) {
                address[] memory path = new address[](2);
                path[0] = address(this);
                path[1] = router.WETH();
                router.swapExactTokensForETHSupportingFeeOnTransferTokens(tokensToSwap, 0, path, address(this), block.timestamp);
            } else {
                address[] memory path = new address[](2);
                path[0] = address(this);
                path[1] = usdtAddress;
                router.swapExactTokensForTokensSupportingFeeOnTransferTokens(tokensToSwap, 0, path, address(this), block.timestamp);
            }
            received = _baseBalance() - beforeBal;
        }
        if (received > 0) {
            uint256 marketingAmt = received * marketingTokens / tokensToSwap;
            uint256 lpAmt = received - marketingAmt;
            _sendBase(marketingWallet, marketingAmt);
            if (lpAmt > 0 && lpTokenHalf > 0) {
                _approve(address(this), address(router), lpTokenHalf);
                if (mintMode == MintMode.BNB) router.addLiquidityETH{value: lpAmt}(address(this), lpTokenHalf, 0, 0, owner(), block.timestamp);
                else {
                    IERC20(usdtAddress).forceApprove(address(router), lpAmt);
                    router.addLiquidity(address(this), usdtAddress, lpTokenHalf, lpAmt, 0, 0, owner(), block.timestamp);
                }
            }
        }
        emit SwapBack(tokenAmount, received);
    }

    function forceSwapBack() external onlyOwner { _swapBack(pendingTaxTokens); }
    function forceAddLiquidity(uint256 tokenAmount, uint256 fundAmount) external payable onlyOwner nonReentrant lockSwap {
        require(tokenAmount > 0 && fundAmount > 0, "zero amount");
        _approve(address(this), address(router), tokenAmount);
        if (mintMode == MintMode.BNB) {
            require(msg.value == fundAmount, "bad BNB");
            router.addLiquidityETH{value: fundAmount}(address(this), tokenAmount, 0, 0, owner(), block.timestamp);
        } else {
            IERC20(usdtAddress).safeTransferFrom(msg.sender, address(this), fundAmount);
            IERC20(usdtAddress).forceApprove(address(router), fundAmount);
            router.addLiquidity(address(this), usdtAddress, tokenAmount, fundAmount, 0, 0, owner(), block.timestamp);
        }
    }

    function _isRemovingLiquidity() internal view returns (bool) {
        address base = mintMode == MintMode.BNB ? router.WETH() : usdtAddress;
        (bool reserveOk, bytes memory reserveData) = pair.staticcall(abi.encodeWithSignature("getReserves()"));
        (bool token0Ok, bytes memory token0Data) = pair.staticcall(abi.encodeWithSignature("token0()"));
        if (!reserveOk || !token0Ok || reserveData.length < 96 || token0Data.length < 32) return false;
        (uint112 reserve0, uint112 reserve1,) = abi.decode(reserveData, (uint112, uint112, uint32));
        address token0 = abi.decode(token0Data, (address));
        uint256 baseReserve = token0 == base ? uint256(reserve0) : uint256(reserve1);
        return baseReserve > 0 && IERC20(base).balanceOf(pair) <= baseReserve;
    }
    function _openTrading() internal { if (!tradingOpen) { tradingOpen = true; tradingStartTime = block.timestamp; mintEnabled = false; emit TradingOpened(block.timestamp); } }
    function openTrading() external onlyOwner { _openTrading(); }
    function enableLiquidityRemoval() external onlyOwner { require(tradingOpen, "trading not open"); require(!liquidityRemovalEnabled, "already enabled"); liquidityRemovalEnabled = true; emit LiquidityRemovalEnabled(block.timestamp); }
    function closeMint() external onlyOwner { mintEnabled = false; }
    function setMintPrice(uint256 v) external onlyOwner { mintPrice = v; }
    function setTokenPerMint(uint256 v) external onlyOwner { tokenPerMint = v; }
    function setMaxMintCount(uint256 v) external onlyOwner { require(v >= mintedCount, "lt minted"); maxMintCount = v; }
    function setLaunchTime(uint256 v) external onlyOwner { launchTime = v; startTime = v; openTime = v; tradingStartTime = v; }
    function setWhitelistEnabled(bool v) external onlyOwner { whitelistEnabled = v; }
    function setWhitelist(address user, bool v) external onlyOwner { whitelist[user] = v; }
    function batchSetWhitelist(address[] calldata users, bool v) external onlyOwner { for (uint256 i; i < users.length; i++) whitelist[users[i]] = v; }
    function setExcludedFromFee(address user, bool v) external onlyOwner { require(!feeExemptionsLocked, "fee exemptions locked"); isExcludedFromFee[user] = v; }
    function setBuyLimitEnabled(bool v) external onlyOwner { if (v) { buyAmountLimitEnabled = false; timedBuyLimitEnabled = false; } buyLimitEnabled = v; }
    function setMaxBuyAmountPerWallet(uint256 v) external onlyOwner { maxBuyAmountPerWallet = v; }
    function setBuyAmountLimitEnabled(bool v) external onlyOwner { if (v) { buyLimitEnabled = false; timedBuyLimitEnabled = false; } buyAmountLimitEnabled = v; }
    function setMaxBuyBaseAmountPerWallet(uint256 v) external onlyOwner { maxBuyBaseAmountPerWallet = v; }
    function setTimedBuyLimitEnabled(bool v) external onlyOwner { if (v) { buyLimitEnabled = false; buyAmountLimitEnabled = false; } timedBuyLimitEnabled = v; }
    function setTimedBuyLimitTier(uint256 index, uint256 endMinute, uint256 amount) external onlyOwner { require(index < 3, "bad tier"); timedBuyLimitMinutes[index] = endMinute; timedBuyLimitAmounts[index] = amount; }
    function setBuyWhitelistEnabled(bool v) external onlyOwner { buyWhitelistEnabled = v; }
    function setBuyWhitelist(address user, bool v) external onlyOwner { require(user != address(0), "zero address"); buyWhitelist[user] = v; }
    function batchSetBuyWhitelist(address[] calldata users, bool v) external onlyOwner { for (uint256 i; i < users.length; i++) { require(users[i] != address(0), "zero address"); buyWhitelist[users[i]] = v; } }
    function setPreLaunchBuyWhitelistEnabled(bool v) external onlyOwner { preLaunchBuyWhitelistEnabled = v; }
    function setPreLaunchBuyWhitelist(address user, bool v) external onlyOwner { require(user != address(0), "zero address"); preLaunchBuyWhitelist[user] = v; }
    function batchSetPreLaunchBuyWhitelist(address[] calldata users, bool v) external onlyOwner { for (uint256 i; i < users.length; i++) { require(users[i] != address(0), "zero address"); preLaunchBuyWhitelist[users[i]] = v; } }
    function lockTaxes() external onlyOwner { taxesLocked = true; }
    function lockFeeExemptions() external onlyOwner { feeExemptionsLocked = true; }
    function disablePauseForever() external onlyOwner { pauseDisabledForever = true; }
    function setBuyTax(uint256 v) external onlyOwner { require(!taxesLocked, "taxes locked"); require(v <= MAX_TAX, "tax > 5%"); buyTax = v; }
    function setSellTax(uint256 v) external onlyOwner { require(!taxesLocked, "taxes locked"); require(v <= MAX_SELL_TAX, "sell tax > 100%"); sellTax = v; }
    function setTransferTax(uint256 v) external onlyOwner { require(!taxesLocked, "taxes locked"); require(v <= MAX_TAX, "tax > 5%"); transferTax = v; }
    function setTaxShares(uint256 marketing, uint256 burn, uint256 lp, uint256 dividend) external onlyOwner { require(!taxesLocked, "taxes locked"); require(marketing + burn + lp + dividend == DENOMINATOR, "sum != 10000"); marketingShare = marketing; burnShare = burn; lpShare = lp; dividendShare = dividend; }
    function setMarketingWallet(address v) external onlyOwner { require(v != address(0), "zero"); marketingWallet = v; }
    function setSwapEnabled(bool v) external onlyOwner { swapEnabled = v; }
    function setSwapThreshold(uint256 v) external onlyOwner { swapThreshold = v; }
    function pause() external onlyOwner { require(!pauseDisabledForever, "pause disabled"); require(!tradingOpen, "trading open"); _pause(); }
    function unpause() external onlyOwner { _unpause(); }
    function withdrawBNB(uint256 amount) external onlyOwner {
        uint256 bal = address(this).balance;
        uint256 toSend = amount == 0 ? bal : amount;
        require(toSend <= bal, "exceeds available");
        payable(owner()).transfer(toSend);
    }
    function withdrawToken(address token, uint256 amount) external onlyOwner {
        IERC20 erc = IERC20(token);
        uint256 bal = erc.balanceOf(address(this));
        uint256 toSend = amount == 0 ? bal : amount;
        require(toSend <= bal, "exceeds available");
        erc.safeTransfer(owner(), toSend);
    }
    function withdrawLP(uint256 amount) external onlyOwner {
        IERC20 lpToken = IERC20(pair);
        uint256 bal = lpToken.balanceOf(address(this));
        lpToken.safeTransfer(owner(), amount == 0 ? bal : amount);
    }
}`;

const ZERO = "0x0000000000000000000000000000000000000000";
const OPENZEPPELIN_BASE = "https://unpkg.com/@openzeppelin/contracts@5.0.2/";
const ERC20_ABI = [
  "function approve(address spender,uint256 amount) external returns (bool)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)"
];
const DIVIDEND_DISTRIBUTOR_ABI = [
  "function rewardTokenAddress() view returns (address)",
  "function pendingTokenDividend(address user) view returns (uint256)",
  "function pendingLPDividend(address user) view returns (uint256)",
  "function dividendReserve() view returns (uint256)",
  "function minTokenDividendBalance() view returns (uint256)",
  "function autoDividendEnabled() view returns (bool)",
  "function autoDividendBatchSize() view returns (uint256)",
  "function dividendHolderCount() view returns (uint256)",
  "function dividendExcludedCount() view returns (uint256)",
  "function eligibleTokenDividendSupply() view returns (uint256)",
  "function eligibleLPDividendSupply() view returns (uint256)",
  "function isExcludedFromDividends(address user) view returns (bool)",
  "function claimDividends()",
  "function syncLPDividendDebt()",
  "function setExcludedFromDividends(address user, bool v)",
  "function batchSetExcludedFromDividends(address[] users, bool v)",
  "function setRewardToken(address v)",
  "function setMinTokenDividendBalance(uint256 v)",
  "function setAutoDividendEnabled(bool v)",
  "function setAutoDividendBatchSize(uint256 v)",
  "function fundTokenDividendBNB() payable",
  "function fundTokenDividendToken(uint256 amount)",
  "function fundLPDividendBNB() payable",
  "function fundLPDividendToken(uint256 amount)",
  "function withdrawDividendReserve(uint256 amount)"
];
const ADMIN_TOKEN_ABI = [
  "function owner() view returns (address)",
  "function pair() view returns (address)",
  "function mintMode() view returns (uint8)",
  "function mintPrice() view returns (uint256)",
  "function tokenPerMint() view returns (uint256)",
  "function mintedCount() view returns (uint256)",
  "function maxMintCount() view returns (uint256)",
  "function mintEnabled() view returns (bool)",
  "function tradingOpen() view returns (bool)",
  "function liquidityRemovalEnabled() view returns (bool)",
  "function buyTax() view returns (uint256)",
  "function sellTax() view returns (uint256)",
  "function transferTax() view returns (uint256)",
  "function marketingShare() view returns (uint256)",
  "function burnShare() view returns (uint256)",
  "function lpShare() view returns (uint256)",
  "function dividendShare() view returns (uint256)",
  "function dividendTargetMode() view returns (uint8)",
  "function marketingWallet() view returns (address)",
  "function swapThreshold() view returns (uint256)",
  "function dividendReserve() view returns (uint256)",
  "function dividendReserveView() view returns (uint256)",
  "function buyLimitEnabled() view returns (bool)",
  "function maxBuyAmountPerWallet() view returns (uint256)",
  "function minTokenDividendBalance() view returns (uint256)",
  "function minTokenDividendBalanceView() view returns (uint256)",
  "function autoDividendEnabled() view returns (bool)",
  "function autoDividendEnabledView() view returns (bool)",
  "function autoDividendBatchSize() view returns (uint256)",
  "function autoDividendBatchSizeView() view returns (uint256)",
  "function dividendHolderCount() view returns (uint256)",
  "function buyAmountLimitEnabled() view returns (bool)",
  "function maxBuyBaseAmountPerWallet() view returns (uint256)",
  "function timedBuyLimitEnabled() view returns (bool)",
  "function timedBuyLimitMinutes(uint256) view returns (uint256)",
  "function timedBuyLimitAmounts(uint256) view returns (uint256)",
  "function buyWhitelistEnabled() view returns (bool)",
  "function preLaunchBuyWhitelistEnabled() view returns (bool)",
  "function dividendExcludedCount() view returns (uint256)",
  "function eligibleTokenDividendSupply() view returns (uint256)",
  "function eligibleLPDividendSupply() view returns (uint256)",
  "function taxesLocked() view returns (bool)",
  "function feeExemptionsLocked() view returns (bool)",
  "function pauseDisabledForever() view returns (bool)",
  "function externalDividendDistributorEnabled() view returns (bool)",
  "function dividendDistributor() view returns (address)",
  "function rewardTokenAddress() view returns (address)",
  "function usdtAddress() view returns (address)",
  "function pendingTokenDividend(address) view returns (uint256)",
  "function pendingLPDividend(address) view returns (uint256)",
  "function setMintPrice(uint256)",
  "function setTokenPerMint(uint256)",
  "function setMaxMintCount(uint256)",
  "function setLaunchTime(uint256)",
  "function openTrading()",
  "function enableLiquidityRemoval()",
  "function closeMint()",
  "function pause()",
  "function unpause()",
  "function disablePauseForever()",
  "function setWhitelistEnabled(bool)",
  "function setWhitelist(address,bool)",
  "function batchSetWhitelist(address[],bool)",
  "function setBuyWhitelistEnabled(bool)",
  "function setBuyWhitelist(address,bool)",
  "function batchSetBuyWhitelist(address[],bool)",
  "function setPreLaunchBuyWhitelistEnabled(bool)",
  "function setPreLaunchBuyWhitelist(address,bool)",
  "function batchSetPreLaunchBuyWhitelist(address[],bool)",
  "function setExcludedFromFee(address,bool)",
  "function lockFeeExemptions()",
  "function setBuyTax(uint256)",
  "function setSellTax(uint256)",
  "function setTransferTax(uint256)",
  "function setTaxShares(uint256,uint256,uint256,uint256)",
  "function lockTaxes()",
  "function setMarketingWallet(address)",
  "function setDividendTargetMode(uint256)",
  "function setSwapThreshold(uint256)",
  "function setBuyLimitEnabled(bool)",
  "function setMaxBuyAmountPerWallet(uint256)",
  "function setBuyAmountLimitEnabled(bool)",
  "function setMaxBuyBaseAmountPerWallet(uint256)",
  "function setTimedBuyLimitEnabled(bool)",
  "function setTimedBuyLimitTier(uint256,uint256,uint256)",
  "function processPendingDividends()",
  "function forceSwapBack()",
  "function forceAddLiquidity(uint256,uint256)",
  "function withdrawBNB(uint256)",
  "function withdrawToken(address,uint256)",
  "function withdrawLP(uint256)",
  "function renounceOwnership()"
];
function compiledConstructorTypes() {
  const constructor = state.compiled?.abi?.find((item) => item.type === "constructor");
  if (!constructor) throw new Error("编译结果中没有找到构造函数。");
  return constructor.inputs.map((input) => input.type);
}
const NETWORK_DEFAULTS = {
  56: {
    name: "BSC 主网",
    native: "BNB",
    router: "0x10ED43C718714eb63d5aA57B78B54704E256024E",
    usdt: "0x55d398326f99059fF775485246999027B3197955"
  },
  97: {
    name: "BSC 测试网",
    native: "tBNB",
    router: "0xD99D1c33F9fC3444f8101754aBC46c52416550D1",
    usdt: ""
  }
};
const state = { provider: null, signer: null, account: null, compiled: null, admin: null, mint: null, dividendAdmin: null };

const EVM_MAX_RUNTIME_CODE_SIZE = 24576;
const EVM_MAX_INIT_CODE_SIZE = 49152;

const $ = (id) => document.getElementById(id);
const log = (msg) => { $("log").textContent = `[${new Date().toLocaleTimeString()}] ${msg}\n` + $("log").textContent; };
const parseToken = (v) => ethers.parseUnits(String(v || "0"), 18);
const parseBool = (v) => v === true || v === "true";
const txDone = async (tx, label) => { log(`${label} 已提交：${tx.hash}`); await tx.wait(); log(`${label} 已确认`); };
const hexByteLength = (hex) => {
  const raw = String(hex || "").replace(/^0x/, "");
  if (!raw) return 0;
  return Math.floor(raw.length / 2);
};

async function approveIfNeeded(tokenAddress, spender, amount, label) {
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, state.signer);
  const allowance = await token.allowance(state.account, spender);
  if (allowance >= amount) return;
  await txDone(await token.approve(spender, amount), `${label} 授权`);
}

async function assertTokenBalance(tokenAddress, owner, amount, label) {
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, state.signer);
  const balance = await token.balanceOf(owner);
  if (balance < amount) throw new Error(`${label} 余额不足。需要 ${ethers.formatUnits(amount, 18)}，当前 ${ethers.formatUnits(balance, 18)}。`);
}

async function rewardInfo(contract, fallbackContract = contract) {
  const resolveMintMode = async () => {
    if (typeof contract.mintMode === "function") return Number(await contract.mintMode());
    if (fallbackContract && typeof fallbackContract.mintMode === "function") return Number(await fallbackContract.mintMode());
    return 0;
  };
  const resolveUsdtAddress = async () => {
    if (typeof contract.usdtAddress === "function") return await contract.usdtAddress();
    if (fallbackContract && typeof fallbackContract.usdtAddress === "function") return await fallbackContract.usdtAddress();
    return ZERO;
  };
  const rewardAddress = await contract.rewardTokenAddress().catch(async () => {
    const mode = await resolveMintMode();
    return mode === 0 ? ZERO : await resolveUsdtAddress();
  });
  if (rewardAddress === ZERO) {
    const mode = await resolveMintMode();
    const defaults = activeNetworkDefaults();
    return { address: ZERO, symbol: mode === 0 ? (defaults?.native || "BNB") : "USDT", decimals: 18, native: true };
  }
  const token = new ethers.Contract(rewardAddress, ERC20_ABI, state.signer || state.provider);
  const [symbol, decimals] = await Promise.all([
    token.symbol().catch(() => "TOKEN"),
    token.decimals().catch(() => 18)
  ]);
  return { address: rewardAddress, symbol, decimals: Number(decimals), native: false };
}

async function dividendContractInfo(tokenContract) {
  const [enabled, distributor] = await Promise.all([
    tokenContract.externalDividendDistributorEnabled().catch(() => false),
    tokenContract.dividendDistributor().catch(() => ZERO)
  ]);
  return {
    enabled: Boolean(enabled) && distributor !== ZERO,
    address: distributor
  };
}

async function dividendAdminContract(tokenContract) {
  const info = await dividendContractInfo(tokenContract);
  if (!info.enabled) return tokenContract;
  return new ethers.Contract(info.address, DIVIDEND_DISTRIBUTOR_ABI, state.signer);
}

async function readValue(promiseFactory, fallback) {
  try {
    return await promiseFactory();
  } catch {
    return fallback;
  }
}

function makeDownload(id, filename, content, type = "application/json") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = $(id);
  if (link.dataset.url) URL.revokeObjectURL(link.dataset.url);
  link.href = url;
  link.dataset.url = url;
  link.download = filename;
}

function jsonSafe(value) {
  return JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item, 2);
}

const deployFormEl = () => $("deployForm");

const TEMPLATE_CONFIGS = {
  light: {
    title: "轻量基础版",
    summary: "没有分红、没有限购、没有复杂白名单，适合最轻的代币基础盘。",
    details: [
      ["适用场景", "只想快速发一个基础盘，不做税收和运营玩法。"],
      ["部署特征", "保留基础信息、网络、开盘和尾号定制，隐藏税收、分红、限购。"],
      ["后台重点", "只保留 Mint / 开盘 / 提币等基础操作。"],
      ["链上风格", "体积最轻，部署和验证最省心。"] 
    ],
    features: ["mint", "launch"]
  },
  mint: {
    title: "Mint 专用版",
    summary: "保留 fair mint、开盘和 LP 注入，不带税收分红，适合纯发射盘。",
    details: [
      ["适用场景", "只需要 Mint、开盘、自动或手动加池，不做后续税务运营。"],
      ["部署特征", "显示 Mint 配置与开盘设置，隐藏税率、分红、限购。"],
      ["后台重点", "Mint 参数、开盘、加池、提 LP。"],
      ["链上风格", "比综合版更轻，适合做干净首发。"] 
    ],
    features: ["mint", "launch"]
  },
  tax: {
    title: "标准税收版",
    summary: "有税、有营销、有回流 LP，但不做分红和复杂限制。",
    details: [
      ["适用场景", "常规交易盘，重点在税收、营销和 LP 回流。"],
      ["部署特征", "显示税率、税收分配和开盘，隐藏 Mint、分红、限购。"],
      ["后台重点", "税率、营销钱包、SwapBack、加池。"],
      ["链上风格", "比高级限制版更轻，更适合长期维护。"] 
    ],
    features: ["mint", "tax", "launch"]
  },
  mintTax: {
    title: "Mint + 税收版",
    summary: "Mint 首发加后续交易税，是最常见的发射盘模板之一。",
    details: [
      ["适用场景", "先 fair mint，再通过买卖税进行营销和回流。"],
      ["部署特征", "同时显示 Mint、税率和开盘，隐藏分红、限购。"],
      ["后台重点", "Mint 参数、税率、营销钱包、SwapBack。"],
      ["链上风格", "兼顾首发和后续运营，功能与体积较平衡。"] 
    ],
    features: ["mint", "tax", "launch"]
  },
  dividendInternal: {
    title: "内置分红版",
    summary: "分红逻辑写在主合约里，部署简单，但主合约更重。",
    details: [
      ["适用场景", "想要一体化分红，不想额外维护 distributor。"],
      ["部署特征", "显示 Mint、税率、分红配置和开盘，默认内置分红。"],
      ["后台重点", "分红门槛、自动分红、分红储备、排除地址。"],
      ["链上风格", "功能集中，但主合约体积和复杂度更高。"] 
    ],
    features: ["mint", "tax", "dividend", "launch"]
  },
  dividendExternal: {
    title: "独立分红版",
    summary: "主合约负责税收，分红走单独 distributor，适合保留分红可维护性。",
    details: [
      ["适用场景", "主合约想丢权限，但分红仍要保留单独调整入口。"],
      ["部署特征", "显示税率、分红配置和分红管理员，默认独立分红。"],
      ["后台重点", "主合约管税收，分红相关按钮自动切到独立分红合约。"],
      ["链上风格", "结构更清晰，适合需要分离控制权的项目。"] 
    ],
    features: ["mint", "tax", "dividend", "launch"]
  },
  lpDividend: {
    title: "LP 分红版",
    summary: "重点服务 LP 持有人，带 LP 分红入口，同时保留基础持币分红配置。",
    details: [
      ["适用场景", "希望鼓励做市和持有 LP，希望 LP 地址单独拿分红。"],
      ["部署特征", "显示税率、分红配置、LP 分红资金入口和开盘。"],
      ["后台重点", "LP 分红注资、分红门槛、排除地址、加池和 LP 管理。"],
      ["链上风格", "比纯持币分红更偏运营，后台要重点维护 LP 储备。"] 
    ],
    features: ["mint", "tax", "dividend", "lpDividend", "launch"]
  },
  advanced: {
    title: "高级限制版",
    summary: "带限购、白名单、预开盘白名单和税收，是最全的运营模板。",
    details: [
      ["适用场景", "需要强运营控制、分阶段放量、开盘前筛地址。"],
      ["部署特征", "显示几乎所有配置项，包括限购、名单、税率、分红。"],
      ["后台重点", "白名单、限购、税率、分红、开盘与暂停。"],
      ["链上风格", "功能最全，体积和风险检测分数也通常最高。"] 
    ],
    features: ["mint", "tax", "limits", "launch"]
  },
  trade: {
    title: "纯交易版",
    summary: "不做 fair mint，只保留交易、税收、开盘和流动性管理。",
    details: [
      ["适用场景", "直接常规发盘，不走 Mint 流程。"],
      ["部署特征", "隐藏 Mint 配置，只保留税收、开盘、加池和提币。"],
      ["后台重点", "开盘、税率、营销、加池和 LP 提取。"],
      ["链上风格", "适合 meme / 社区币常规上池流程。"] 
    ],
    features: ["mint", "tax", "launch"]
  }
};

const TEMPLATE_GUIDES = {
  light: {
    deploy: [
      ["部署前填写", "填写代币名称、符号、总供应量、路由和开盘方式即可。"],
      ["推荐场景", "适合最基础的代币部署，不做税收、分红和复杂限制。"],
      ["部署注意", "上线后以开盘、加池、提取预留代币为主。"]
    ],
    admin: [
      ["后台可用", "保留基础 Mint、开盘、加池、提币等常用操作。"],
      ["后台不含", "没有分红、限购、复杂白名单相关管理。"],
      ["维护强度", "维护最轻，适合低频管理。"]
    ]
  },
  mint: {
    deploy: [
      ["部署前填写", "重点填写 Mint 价格、单次到币、Mint 次数、到币方式和开盘模式。"],
      ["推荐场景", "适合纯 Mint 发射盘，不做交易税运营。"],
      ["部署注意", "税率和分红设置不会作为本版核心功能参与。"]
    ],
    admin: [
      ["后台可用", "可管理 Mint 状态、关闭 Mint、开盘、加流动性、提 LP。"],
      ["后台不含", "没有税收调节、分红调节和高级限购。"],
      ["维护强度", "先 Mint 后开盘，流程很直接。"]
    ]
  },
  tax: {
    deploy: [
      ["部署前填写", "重点填写买卖税、税收分配、营销钱包、路由和开盘模式。"],
      ["推荐场景", "适合直接做交易盘，靠税收做营销和回流 LP。"],
      ["部署注意", "不走 Mint 发射流程，主要看税率和税分配是否合理。"]
    ],
    admin: [
      ["后台可用", "可调税率、查看税收处理、开盘、加池和管理营销钱包。"],
      ["后台不含", "没有分红后台和高级白名单逻辑。"],
      ["维护强度", "以交易运营和流动性维护为主。"]
    ]
  },
  mintTax: {
    deploy: [
      ["部署前填写", "先填 Mint 参数，再填税率和税分配，最后确认开盘方式。"],
      ["推荐场景", "适合先发射 Mint，再进入交易税运营。"],
      ["部署注意", "这是发射盘最均衡的一版，功能和体积比较平衡。"]
    ],
    admin: [
      ["后台可用", "可管理 Mint、开盘、税率、营销钱包、SwapBack 和流动性。"],
      ["后台不含", "没有分红管理和高级限购名单管理。"],
      ["维护强度", "先看 Mint 是否完成，再切到交易运营。"]
    ]
  },
  dividendInternal: {
    deploy: [
      ["部署前填写", "除 Mint 和税率外，还要填分红代币、分红比例、最低分红持币量。"],
      ["推荐场景", "适合想把分红逻辑全部写在主合约里的项目。"],
      ["部署注意", "主合约更重，但部署时不需要额外创建独立分红合约。"]
    ],
    admin: [
      ["后台可用", "可管理分红门槛、自动分红、分红储备和排除分红地址。"],
      ["后台位置", "分红逻辑在主合约，后台直接调用主合约。"],
      ["维护强度", "适合喜欢一体化后台的项目。"]
    ]
  },
  dividendExternal: {
    deploy: [
      ["部署前填写", "除常规参数外，要确认分红模式为独立分红，并设置分红管理员。"],
      ["推荐场景", "适合把主合约和分红权限拆开管理。"],
      ["部署注意", "部署时会额外创建独立分红合约，步骤比内置分红多一步。"]
    ],
    admin: [
      ["后台可用", "税收相关走主合约，分红相关自动切到独立分红合约。"],
      ["后台位置", "分红管理员、排除地址、自动分红参数主要在 distributor 维护。"],
      ["维护强度", "适合后期想分离控制权的项目。"]
    ]
  },
  lpDividend: {
    deploy: [
      ["部署前填写", "重点确认税分配、分红代币、LP 相关设置和开盘方式。"],
      ["推荐场景", "适合希望把运营重点放在 LP 持有者激励上的项目。"],
      ["部署注意", "建议先确定 LP 分红储备来源，再部署。"]
    ],
    admin: [
      ["后台可用", "可管理持币分红、LP 分红入口、排除地址和分红储备。"],
      ["后台重点", "需要额外关注 LP 地址、LP 储备和加池状态。"],
      ["维护强度", "偏运营型模板，适合持续维护。"]
    ]
  },
  advanced: {
    deploy: [
      ["部署前填写", "可同时配置 Mint、税率、分红、限购、金额限购和白名单。"],
      ["推荐场景", "适合需要强运营控制、阶段性放量和名单管理的完整项目。"],
      ["部署注意", "功能最多，部署前建议先把限购和白名单策略想清楚。"]
    ],
    admin: [
      ["后台可用", "保留税率、分红、限购、白名单、开盘、暂停等几乎全部功能。"],
      ["后台重点", "重点看限购参数、买入白名单、预开盘白名单和分红排除管理。"],
      ["维护强度", "功能最全，后台维护频率也最高。"]
    ]
  },
  trade: {
    deploy: [
      ["部署前填写", "不需要 Mint 配置，主要填写税率、分配、开盘方式和营销钱包。"],
      ["推荐场景", "适合传统交易盘、社区盘、meme 盘直接开池。"],
      ["部署注意", "这版最接近常规交易代币，不走发射 Mint。"]
    ],
    admin: [
      ["后台可用", "以开盘、税率、加池、提 LP 和营销维护为主。"],
      ["后台不含", "没有 Mint 后台和复杂分红限购。"],
      ["维护强度", "部署后围绕交易和流动性维护。"]
    ]
  }
};

const TEMPLATE_RECOMMENDATIONS = {
  light: [
    ["税率建议", "买 0%，卖 0%，转账 0%。"],
    ["分红建议", "关闭分红，奖励代币留空。"],
    ["限购建议", "默认关闭限购和白名单。"]
  ],
  mint: [
    ["税率建议", "买 0%，卖 0%，转账 0%。"],
    ["分红建议", "关闭分红，重点把 Mint 和开盘参数配顺。"],
    ["限购建议", "默认关闭限购，保持发射流程干净。"]
  ],
  tax: [
    ["税率建议", "买 0% 到 3%，卖 3% 到 5%，转账 0%。"],
    ["分配建议", "营销 50%，回流 LP 50%，分红 0%。"],
    ["限购建议", "默认关闭，除非你想控盘节奏。"]
  ],
  mintTax: [
    ["税率建议", "买 0% 到 2%，卖 3% 到 5%，转账 0%。"],
    ["分配建议", "营销 40%，回流 LP 40%，销毁 0% 到 20%，分红 0%。"],
    ["限购建议", "默认关闭，首发盘通常先看 Mint 再决定是否开。"]
  ],
  dividendInternal: [
    ["税率建议", "买 1% 到 3%，卖 4% 到 6%，转账 0%。"],
    ["分红建议", "分红占税收分配 20% 到 40%，最低分红持币量先设成总量的 0.01% 左右。"],
    ["限购建议", "默认关闭，先把分红链路跑通。"]
  ],
  dividendExternal: [
    ["税率建议", "买 1% 到 3%，卖 4% 到 6%，转账 0%。"],
    ["分红建议", "分红占税收分配 20% 到 40%，分红管理员默认用部署钱包。"],
    ["限购建议", "默认关闭，先确认独立分红合约运作正常。"]
  ],
  lpDividend: [
    ["税率建议", "买 2% 到 4%，卖 4% 到 6%，转账 0%。"],
    ["分配建议", "LP/分红总占比可先放 50% 到 70%，营销留 20% 到 40%。"],
    ["限购建议", "可先关闭，等 LP 持仓结构稳定后再决定。"]
  ],
  advanced: [
    ["税率建议", "买 1% 到 3%，卖 3% 到 5%，转账 0% 到 1%。"],
    ["分红建议", "分红占比 10% 到 30%，其余给营销和 LP，避免一开始分红过重。"],
    ["限购建议", "推荐开启代币限购或金额限购其一，并按需开启买入白名单。"]
  ],
  trade: [
    ["税率建议", "买 0% 到 2%，卖 3% 到 5%，转账 0%。"],
    ["分红建议", "默认关闭分红，先把交易和流动性做好。"],
    ["限购建议", "默认关闭，社区盘通常先追求流通。"]
  ]
};

function templateConfig(template) {
  return TEMPLATE_CONFIGS[template] || TEMPLATE_CONFIGS.mintTax;
}

function templateGuideConfig(template) {
  return TEMPLATE_GUIDES[template] || TEMPLATE_GUIDES.mintTax;
}

function templateRecommendationConfig(template) {
  return TEMPLATE_RECOMMENDATIONS[template] || TEMPLATE_RECOMMENDATIONS.mintTax;
}

const TEMPLATE_SOURCE_BINDINGS = {
  light: "light",
  mint: "mint",
  tax: "tax",
  mintTax: "mintTax",
  trade: "trade",
  dividendInternal: "dividendInternal",
  dividendExternal: "dividendExternal",
  lpDividend: "lpDividend",
  advanced: "advanced"
};

const FEATURE_PRESETS = {
  light: { mint: true, tax: false, dividend: false, lpDividend: false, limits: false },
  mint: { mint: true, tax: false, dividend: false, lpDividend: false, limits: false },
  tax: { mint: false, tax: true, dividend: false, lpDividend: false, limits: false },
  mintTax: { mint: true, tax: true, dividend: false, lpDividend: false, limits: false },
  dividendInternal: { mint: true, tax: true, dividend: true, lpDividend: false, limits: false },
  dividendExternal: { mint: true, tax: true, dividend: true, lpDividend: false, limits: false },
  lpDividend: { mint: true, tax: true, dividend: true, lpDividend: true, limits: false },
  advanced: { mint: true, tax: true, dividend: false, lpDividend: false, limits: true },
  trade: { mint: false, tax: true, dividend: false, lpDividend: false, limits: false }
};

function setFeatureToggle(name, checked) {
  const field = formField(name);
  if (field) field.checked = !!checked;
}

function selectedModuleConfig() {
  const mint = !!formField("featureMint")?.checked;
  const tax = !!formField("featureTax")?.checked;
  const dividend = !!formField("featureDividend")?.checked;
  const lpDividend = !!formField("featureLPDividend")?.checked;
  const limits = !!formField("featureLimits")?.checked;
  return { mint, tax, dividend, lpDividend, limits };
}

function selectedFeatureSet() {
  const modules = selectedModuleConfig();
  const set = new Set(["launch"]);
  if (modules.mint) set.add("mint");
  if (modules.tax) set.add("tax");
  if (modules.dividend) set.add("dividend");
  if (modules.lpDividend) {
    set.add("dividend");
    set.add("lpDividend");
  }
  if (modules.limits) set.add("limits");
  return set;
}

function moduleVariantKey(modules = selectedModuleConfig()) {
  return [
    modules.mint ? "mint" : "nomint",
    modules.tax ? "tax" : "notax",
    modules.dividend ? "div" : "nodiv",
    modules.lpDividend ? "lpdiv" : "nolpdiv",
    modules.limits ? "limits" : "nolimits"
  ].join("-");
}

function replaceRequired(source, from, to, label) {
  if (!source.includes(from)) {
    throw new Error(`assemble source missing block: ${label}`);
  }
  return source.replace(from, to);
}

const LITE_MINT_BLOCK = String.raw`    receive() external payable nonReentrant whenNotPaused { if (msg.sender == address(router)) return; _mintBNB(msg.sender, msg.value); }
    function decimals() public pure override returns (uint8) { return 18; }
    function dividendMode() external pure returns (uint8) { return 0; }
    function activeDividendContract() external view returns (address) { return address(this); }
    function rewardTokenAddress() public view returns (address) { return rewardToken == address(0) ? (mintMode == MintMode.BNB ? address(0) : usdtAddress) : rewardToken; }
    function dividendReserveView() external pure returns (uint256) { return 0; }
    function minTokenDividendBalanceView() external view returns (uint256) { return minTokenDividendBalance; }
    function autoDividendEnabledView() external view returns (bool) { return autoDividendEnabled; }
    function autoDividendBatchSizeView() external view returns (uint256) { return autoDividendBatchSize; }
    function processPendingDividends() external pure {}
    function isDividendExcluded(address) external pure returns (bool) { return false; }
    function dividendExcludedCount() external pure returns (uint256) { return 0; }
    function dividendHolderCount() external pure returns (uint256) { return 0; }
    function eligibleTokenDividendSupply() public view returns (uint256) { return totalSupply(); }
    function eligibleLPDividendSupply() public pure returns (uint256) { return 0; }
    function pendingTokenDividend(address) public pure returns (uint256) { return 0; }
    function pendingLPDividend(address) public pure returns (uint256) { return 0; }
    function claimDividends() external pure { revert("dividend disabled"); }
    function syncLPDividendDebt() external pure {}
    function setDividendDistributor(address distributor, bool enabled) external onlyOwner { dividendDistributor = distributor; externalDividendDistributorEnabled = enabled && distributor != address(0); }
    function setExcludedFromDividends(address, bool) external pure {}
    function batchSetExcludedFromDividends(address[] calldata, bool) external pure {}
    function setMinTokenDividendBalance(uint256 v) external onlyOwner { minTokenDividendBalance = v; }
    function setAutoDividendEnabled(bool v) external onlyOwner { autoDividendEnabled = v; }
    function setAutoDividendBatchSize(uint256 v) external onlyOwner { autoDividendBatchSize = v; }
    function fundTokenDividendBNB() external payable onlyOwner {}
    function fundTokenDividendToken(uint256) public pure {}
    function fundTokenDividendUSDT(uint256) external pure {}
    function fundLPDividendBNB() external payable onlyOwner {}
    function fundLPDividendToken(uint256) public pure {}
    function fundLPDividendUSDT(uint256) external pure {}
    function withdrawDividendReserve(uint256) external pure {}
    function setRewardToken(address v) external onlyOwner { rewardToken = v; }
    function setDividendTargetMode(uint8 v) external onlyOwner { dividendTargetMode = v; }

    function mintBNB() external payable nonReentrant whenNotPaused { _mintBNB(msg.sender, msg.value); }
    function _mintBNB(address user, uint256 amount) internal { require(mintMode == MintMode.BNB, "not BNB mode"); require(amount == mintPrice, "bad BNB amount"); _mintFlow(user, amount); }
    function mintUSDT() external nonReentrant whenNotPaused { require(mintMode == MintMode.USDT, "not USDT mode"); IERC20(usdtAddress).safeTransferFrom(msg.sender, address(this), mintPrice); _mintFlow(msg.sender, mintPrice); }

    function _mintFlow(address user, uint256 paidAmount) internal {
        require(mintEnabled, "mint disabled");
        require(!hasMinted[user], "already minted");
        require(mintedCount < maxMintCount, "mint full");
        if (whitelistEnabled) require(whitelist[user], "not whitelisted");
        hasMinted[user] = true;
        mintedCount += 1;
        uint256 userTokens = userMintMode == UserMintMode.FIXED ? userMintAmount : tokenPerMint * userMintShare / DENOMINATOR;
        uint256 lpTokens = tokenPerMint - userTokens;
        uint256 lpFund = paidAmount * lpFundShare / DENOMINATOR;
        require(balanceOf(address(this)) >= tokenPerMint, "insufficient token reserve");
        if (lpTokens > 0 && lpFund > 0) {
            _approve(address(this), address(router), lpTokens);
            address lpRecipient = mintLPRecipientMode == 1 ? user : owner();
            if (mintMode == MintMode.BNB) router.addLiquidityETH{value: lpFund}(address(this), lpTokens, 0, 0, lpRecipient, block.timestamp);
            else {
                IERC20(usdtAddress).forceApprove(address(router), lpFund);
                router.addLiquidity(address(this), usdtAddress, lpTokens, lpFund, 0, 0, lpRecipient, block.timestamp);
            }
        }
        if (userTokens > 0) _transfer(address(this), user, userTokens);
        emit Minted(user, paidAmount, userTokens, lpTokens, lpFund);
        if (mintedCount >= maxMintCount) { mintEnabled = false; if (launchMode == LaunchMode.AUTO) _openTrading(); }
    }
`;

const LITE_MINT_DISABLED_BLOCK = String.raw`    receive() external payable { revert("mint disabled"); }
    function decimals() public pure override returns (uint8) { return 18; }
    function dividendMode() external pure returns (uint8) { return 0; }
    function activeDividendContract() external view returns (address) { return address(this); }
    function rewardTokenAddress() public view returns (address) { return rewardToken == address(0) ? (mintMode == MintMode.BNB ? address(0) : usdtAddress) : rewardToken; }
    function dividendReserveView() external pure returns (uint256) { return 0; }
    function minTokenDividendBalanceView() external view returns (uint256) { return minTokenDividendBalance; }
    function autoDividendEnabledView() external view returns (bool) { return autoDividendEnabled; }
    function autoDividendBatchSizeView() external view returns (uint256) { return autoDividendBatchSize; }
    function processPendingDividends() external pure {}
    function isDividendExcluded(address) external pure returns (bool) { return false; }
    function dividendExcludedCount() external pure returns (uint256) { return 0; }
    function dividendHolderCount() external pure returns (uint256) { return 0; }
    function eligibleTokenDividendSupply() public view returns (uint256) { return totalSupply(); }
    function eligibleLPDividendSupply() public pure returns (uint256) { return 0; }
    function pendingTokenDividend(address) public pure returns (uint256) { return 0; }
    function pendingLPDividend(address) public pure returns (uint256) { return 0; }
    function claimDividends() external pure { revert("dividend disabled"); }
    function syncLPDividendDebt() external pure {}
    function setDividendDistributor(address distributor, bool enabled) external onlyOwner { dividendDistributor = distributor; externalDividendDistributorEnabled = enabled && distributor != address(0); }
    function setExcludedFromDividends(address, bool) external pure {}
    function batchSetExcludedFromDividends(address[] calldata, bool) external pure {}
    function setMinTokenDividendBalance(uint256 v) external onlyOwner { minTokenDividendBalance = v; }
    function setAutoDividendEnabled(bool v) external onlyOwner { autoDividendEnabled = v; }
    function setAutoDividendBatchSize(uint256 v) external onlyOwner { autoDividendBatchSize = v; }
    function fundTokenDividendBNB() external payable onlyOwner {}
    function fundTokenDividendToken(uint256) public pure {}
    function fundTokenDividendUSDT(uint256) external pure {}
    function fundLPDividendBNB() external payable onlyOwner {}
    function fundLPDividendToken(uint256) public pure {}
    function fundLPDividendUSDT(uint256) external pure {}
    function withdrawDividendReserve(uint256) external pure {}
    function setRewardToken(address v) external onlyOwner { rewardToken = v; }
    function setDividendTargetMode(uint8 v) external onlyOwner { dividendTargetMode = v; }

    function mintBNB() external payable { revert("mint disabled"); }
    function _mintBNB(address, uint256) internal pure { revert("mint disabled"); }
    function mintUSDT() external pure { revert("mint disabled"); }
    function _mintFlow(address, uint256) internal pure { revert("mint disabled"); }
`;

const LITE_TAX_BLOCK = String.raw`    function _update(address from, address to, uint256 amount) internal override {
        if (from == address(0) || to == address(0)) { super._update(from, to, amount); return; }
        if (from == pair && !liquidityRemovalEnabled && _isRemovingLiquidity()) revert("LP removal disabled");
        uint256 grossAmount = amount;
        if (!tradingOpen && launchMode == LaunchMode.TIME && launchTime > 0 && block.timestamp >= launchTime) { tradingOpen = true; tradingStartTime = block.timestamp; emit TradingOpened(block.timestamp); }
        bool exemptLimit = isExcludedFromLimits[from] || isExcludedFromLimits[to];
        bool preLaunchBuy = !tradingOpen && from == pair && preLaunchBuyWhitelistEnabled && preLaunchBuyWhitelist[to];
        if (!tradingOpen && !exemptLimit && !preLaunchBuy) revert("trading not open");
        if (!inSwap && swapEnabled && from != pair && from != address(this)) {
            uint256 taxTokenBalance = pendingTaxTokens;
            if (taxTokenBalance >= swapThreshold && swapThreshold > 0) _swapBack(taxTokenBalance);
        }
        uint256 taxAmount = 0;
        if (!inSwap && !isExcludedFromFee[from] && !isExcludedFromFee[to]) {
            uint256 taxRate;
            if (from == pair) taxRate = buyTax;
            else if (to == pair) taxRate = sellTax;
            else taxRate = transferTax;
            if (taxRate > 0) taxAmount = amount * taxRate / DENOMINATOR;
        }
        if (taxAmount > 0) {
            super._update(from, address(this), taxAmount);
            pendingTaxTokens += taxAmount;
            amount -= taxAmount;
        }
        if (from == pair && buyWhitelistEnabled && !preLaunchBuy) require(buyWhitelist[to], "buy whitelist");
        if (buyLimitEnabled && from == pair && !isExcludedFromLimits[to]) { boughtAmount[to] += amount; require(boughtAmount[to] <= maxBuyAmountPerWallet, "buy limit"); }
        if (buyAmountLimitEnabled && from == pair && !isExcludedFromLimits[to]) { boughtBaseAmount[to] += _baseAmountForBuy(grossAmount); require(boughtBaseAmount[to] <= maxBuyBaseAmountPerWallet, "buy amount limit"); }
        if (timedBuyLimitEnabled && from == pair && !isExcludedFromLimits[to]) { uint256 timedLimit = _currentTimedBuyLimit(); if (timedLimit > 0) { boughtBaseAmount[to] += _baseAmountForBuy(grossAmount); require(boughtBaseAmount[to] <= timedLimit, "time buy limit"); } }
        super._update(from, to, amount);
    }

    function _baseAmountForBuy(uint256 tokenAmountOut) internal view returns (uint256) {
        IPancakePairV2Lite mainPair = IPancakePairV2Lite(pair);
        (uint112 reserve0, uint112 reserve1,) = mainPair.getReserves();
        bool tokenIs0 = mainPair.token0() == address(this);
        uint256 reserveOut = tokenIs0 ? uint256(reserve0) : uint256(reserve1);
        uint256 reserveIn = tokenIs0 ? uint256(reserve1) : uint256(reserve0);
        require(tokenAmountOut > 0 && tokenAmountOut < reserveOut, "bad buy amount");
        return reserveIn * tokenAmountOut * 10000 / ((reserveOut - tokenAmountOut) * 9975) + 1;
    }
    function _currentTimedBuyLimit() internal view returns (uint256) {
        if (!timedBuyLimitEnabled || !tradingOpen || tradingStartTime == 0 || block.timestamp < tradingStartTime) return 0;
        uint256 elapsedMinutes = (block.timestamp - tradingStartTime) / 60;
        for (uint256 i; i < 3; i++) {
            uint256 endMinute = timedBuyLimitMinutes[i];
            uint256 limitAmount = timedBuyLimitAmounts[i];
            if (limitAmount == 0) continue;
            if (endMinute == 0 || elapsedMinutes < endMinute) return limitAmount;
        }
        return 0;
    }

    function _baseBalance() internal view returns (uint256) { return mintMode == MintMode.BNB ? address(this).balance : IERC20(usdtAddress).balanceOf(address(this)); }
    function _sendBase(address to, uint256 amount) internal { if (amount == 0) return; if (mintMode == MintMode.BNB) payable(to).transfer(amount); else IERC20(usdtAddress).safeTransfer(to, amount); }

    function _swapBack(uint256 tokenAmount) internal lockSwap {
        uint256 totalShare = marketingShare + burnShare + lpShare + dividendShare;
        if (totalShare == 0 || tokenAmount == 0) return;
        if (tokenAmount > pendingTaxTokens) tokenAmount = pendingTaxTokens;
        if (tokenAmount == 0) return;
        pendingTaxTokens -= tokenAmount;
        uint256 burnTokens = tokenAmount * burnShare / totalShare;
        uint256 lpTokens = tokenAmount * lpShare / totalShare;
        uint256 dividendTokens = tokenAmount * dividendShare / totalShare;
        uint256 marketingTokens = tokenAmount - burnTokens - lpTokens - dividendTokens;
        if (burnTokens > 0) super._update(address(this), deadWallet, burnTokens);
        uint256 lpTokenHalf = lpTokens / 2;
        uint256 tokensToSwap = marketingTokens + dividendTokens + lpTokenHalf;
        uint256 received;
        if (tokensToSwap > 0) {
            uint256 beforeBal = _baseBalance();
            _approve(address(this), address(router), tokensToSwap);
            if (mintMode == MintMode.BNB) {
                address[] memory path = new address[](2);
                path[0] = address(this);
                path[1] = router.WETH();
                router.swapExactTokensForETHSupportingFeeOnTransferTokens(tokensToSwap, 0, path, address(this), block.timestamp);
            } else {
                address[] memory path = new address[](2);
                path[0] = address(this);
                path[1] = usdtAddress;
                router.swapExactTokensForTokensSupportingFeeOnTransferTokens(tokensToSwap, 0, path, address(this), block.timestamp);
            }
            received = _baseBalance() - beforeBal;
        }
        if (received > 0) {
            uint256 marketingAmt = received * marketingTokens / tokensToSwap;
            uint256 lpAmt = received - marketingAmt;
            _sendBase(marketingWallet, marketingAmt);
            if (lpAmt > 0 && lpTokenHalf > 0) {
                _approve(address(this), address(router), lpTokenHalf);
                if (mintMode == MintMode.BNB) router.addLiquidityETH{value: lpAmt}(address(this), lpTokenHalf, 0, 0, owner(), block.timestamp);
                else {
                    IERC20(usdtAddress).forceApprove(address(router), lpAmt);
                    router.addLiquidity(address(this), usdtAddress, lpTokenHalf, lpAmt, 0, 0, owner(), block.timestamp);
                }
            }
        }
        emit SwapBack(tokenAmount, received);
    }

    function forceSwapBack() external onlyOwner { _swapBack(pendingTaxTokens); }
`;

const LITE_TAX_DISABLED_BLOCK = String.raw`    function _update(address from, address to, uint256 amount) internal override {
        if (from == address(0) || to == address(0)) { super._update(from, to, amount); return; }
        if (from == pair && !liquidityRemovalEnabled && _isRemovingLiquidity()) revert("LP removal disabled");
        uint256 grossAmount = amount;
        if (!tradingOpen && launchMode == LaunchMode.TIME && launchTime > 0 && block.timestamp >= launchTime) {
            tradingOpen = true;
            tradingStartTime = block.timestamp;
            emit TradingOpened(block.timestamp);
        }
        bool exemptLimit = isExcludedFromLimits[from] || isExcludedFromLimits[to];
        bool preLaunchBuy = !tradingOpen && from == pair && preLaunchBuyWhitelistEnabled && preLaunchBuyWhitelist[to];
        if (!tradingOpen && !exemptLimit && !preLaunchBuy) revert("trading not open");
        if (from == pair && buyWhitelistEnabled && !preLaunchBuy) require(buyWhitelist[to], "buy whitelist");
        if (buyLimitEnabled && from == pair && !isExcludedFromLimits[to]) { boughtAmount[to] += amount; require(boughtAmount[to] <= maxBuyAmountPerWallet, "buy limit"); }
        if (buyAmountLimitEnabled && from == pair && !isExcludedFromLimits[to]) { boughtBaseAmount[to] += _baseAmountForBuy(grossAmount); require(boughtBaseAmount[to] <= maxBuyBaseAmountPerWallet, "buy amount limit"); }
        if (timedBuyLimitEnabled && from == pair && !isExcludedFromLimits[to]) { uint256 timedLimit = _currentTimedBuyLimit(); if (timedLimit > 0) { boughtBaseAmount[to] += _baseAmountForBuy(grossAmount); require(boughtBaseAmount[to] <= timedLimit, "time buy limit"); } }
        super._update(from, to, amount);
    }

    function _baseAmountForBuy(uint256 tokenAmountOut) internal view returns (uint256) {
        IPancakePairV2Lite mainPair = IPancakePairV2Lite(pair);
        (uint112 reserve0, uint112 reserve1,) = mainPair.getReserves();
        bool tokenIs0 = mainPair.token0() == address(this);
        uint256 reserveOut = tokenIs0 ? uint256(reserve0) : uint256(reserve1);
        uint256 reserveIn = tokenIs0 ? uint256(reserve1) : uint256(reserve0);
        require(tokenAmountOut > 0 && tokenAmountOut < reserveOut, "bad buy amount");
        return reserveIn * tokenAmountOut * 10000 / ((reserveOut - tokenAmountOut) * 9975) + 1;
    }
    function _currentTimedBuyLimit() internal view returns (uint256) {
        if (!timedBuyLimitEnabled || !tradingOpen || tradingStartTime == 0 || block.timestamp < tradingStartTime) return 0;
        uint256 elapsedMinutes = (block.timestamp - tradingStartTime) / 60;
        for (uint256 i; i < 3; i++) {
            uint256 endMinute = timedBuyLimitMinutes[i];
            uint256 limitAmount = timedBuyLimitAmounts[i];
            if (limitAmount == 0) continue;
            if (endMinute == 0 || elapsedMinutes < endMinute) return limitAmount;
        }
        return 0;
    }

    function _baseBalance() internal view returns (uint256) { return mintMode == MintMode.BNB ? address(this).balance : IERC20(usdtAddress).balanceOf(address(this)); }
    function _sendBase(address to, uint256 amount) internal { if (amount == 0) return; if (mintMode == MintMode.BNB) payable(to).transfer(amount); else IERC20(usdtAddress).safeTransfer(to, amount); }
    function _swapBack(uint256) internal pure {}
    function forceSwapBack() external pure {}
`;

const EXTERNAL_DIVIDEND_DISTRIBUTOR_SOURCE = String.raw`interface IFairMintDividendDistributor {
    function rewardTokenAddress() external view returns (address);
    function pendingTokenDividend(address user) external view returns (uint256);
    function pendingLPDividend(address user) external view returns (uint256);
    function dividendReserve() external view returns (uint256);
    function minTokenDividendBalance() external view returns (uint256);
    function autoDividendEnabled() external view returns (bool);
    function autoDividendBatchSize() external view returns (uint256);
    function dividendHolderCount() external view returns (uint256);
    function dividendExcludedCount() external view returns (uint256);
    function eligibleTokenDividendSupply() external view returns (uint256);
    function eligibleLPDividendSupply() external view returns (uint256);
    function isExcludedFromDividends(address user) external view returns (bool);
    function claimDividends() external;
    function syncLPDividendDebt() external;
    function syncBefore(address user) external;
    function syncAfter(address user) external;
    function processAutoDividends(uint256 maxCount) external;
    function registerMintLP(address user, uint256 amount, uint256 balanceBefore) external;
    function notifyTokenDividendNative() external payable;
    function notifyTokenDividendToken(uint256 amount) external;
    function notifyLPDividendNative() external payable;
    function notifyLPDividendToken(uint256 amount) external;
    function setExcludedFromDividends(address user, bool v) external;
    function batchSetExcludedFromDividends(address[] calldata users, bool v) external;
    function setRewardToken(address v) external;
    function setMinTokenDividendBalance(uint256 v) external;
    function setAutoDividendEnabled(bool v) external;
    function setAutoDividendBatchSize(uint256 v) external;
    function withdrawDividendReserve(uint256 amount) external;
}

contract FairMintDividendDistributor is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant ACC = 1e36;

    address public immutable token;
    address public immutable pair;
    address public immutable router;
    address public rewardToken;
    address public deadWallet;
    uint256 public tokenDividendPerShare;
    uint256 public lpDividendPerShare;
    uint256 public dividendReserve;
    uint256 public minTokenDividendBalance;
    mapping(address => bool) private excludedMap;
    mapping(address => bool) private exclusionKnown;
    address[] public dividendExcludedAddresses;
    mapping(address => uint256) public tokenDividendDebt;
    mapping(address => uint256) public tokenDividendCredit;
    mapping(address => uint256) public lpDividendDebt;
    mapping(address => uint256) public lpBalanceSnapshot;
    mapping(address => uint256) public mintLPEntitlement;
    mapping(address => bool) public lpDividendDisqualified;
    uint256 public eligibleMintLPSupply;
    address[] public dividendHolders;
    mapping(address => bool) public isDividendHolder;
    uint256 public dividendProcessIndex;
    bool public autoDividendEnabled = true;
    uint256 public autoDividendBatchSize = 5;

    event TokenDividendFunded(uint256 amount);
    event LPDividendFunded(uint256 amount);
    event DividendClaimed(address indexed user, uint256 tokenReward, uint256 lpReward);
    event AutoDividendProcessed(uint256 processed, uint256 paid);
    event MintLPRegistered(address indexed user, uint256 amount);
    event LPDividendDisqualified(address indexed user, uint256 requiredBalance, uint256 actualBalance);

    modifier onlyToken() {
        require(msg.sender == token, "only token");
        _;
    }

    constructor(
        address token_,
        address pair_,
        address router_,
        address rewardToken_,
        address deadWallet_,
        address owner_,
        uint256 minTokenDividendBalance_
    ) Ownable(owner_) {
        require(token_ != address(0) && pair_ != address(0) && router_ != address(0), "zero addr");
        token = token_;
        pair = pair_;
        router = router_;
        rewardToken = rewardToken_;
        deadWallet = deadWallet_;
        minTokenDividendBalance = minTokenDividendBalance_;
        _setExcludedFromDividends(address(0), true);
        _setExcludedFromDividends(deadWallet_, true);
        _setExcludedFromDividends(address(this), true);
        _setExcludedFromDividends(token_, true);
        _setExcludedFromDividends(pair_, true);
        _setExcludedFromDividends(router_, true);
    }

    function rewardTokenAddress() public view returns (address) { return rewardToken; }
    function isExcludedFromDividends(address user) public view returns (bool) { return excludedMap[user]; }
    function _isNativeReward() internal view returns (bool) { return rewardToken == address(0); }
    function _tokenBalance(address user) internal view returns (uint256) { return IERC20(token).balanceOf(user); }
    function _lpBalance(address user) internal view returns (uint256) { return IERC20(pair).balanceOf(user); }

    function eligibleTokenDividendSupply() public view returns (uint256) {
        uint256 supply = IERC20(token).totalSupply();
        for (uint256 i; i < dividendExcludedAddresses.length; i++) {
            address user = dividendExcludedAddresses[i];
            if (!excludedMap[user]) continue;
            uint256 excludedBalance = IERC20(token).balanceOf(user);
            if (excludedBalance >= supply) return 0;
            supply -= excludedBalance;
        }
        return supply;
    }

    function eligibleLPDividendSupply() public view returns (uint256) { return eligibleMintLPSupply; }

    function dividendExcludedCount() external view returns (uint256) { return dividendExcludedAddresses.length; }
    function dividendHolderCount() external view returns (uint256) { return dividendHolders.length; }
    function syncBefore(address user) external onlyToken { _accrueTokenDividend(user); }
    function syncAfter(address user) external onlyToken { _settleTokenDividend(user); _trackDividendHolder(user); }
    function registerMintLP(address user, uint256 amount, uint256 balanceBefore) external onlyToken {
        if (user == address(0) || amount == 0 || excludedMap[user] || lpDividendDisqualified[user]) return;
        uint256 requiredBalance = mintLPEntitlement[user];
        if (requiredBalance > 0 && balanceBefore < requiredBalance) { _disqualifyLP(user, balanceBefore); return; }
        mintLPEntitlement[user] = requiredBalance + amount;
        eligibleMintLPSupply += amount;
        lpDividendDebt[user] += amount * lpDividendPerShare / ACC;
        lpBalanceSnapshot[user] = _lpBalance(user);
        _trackDividendHolder(user);
        emit MintLPRegistered(user, amount);
    }
    function notifyTokenDividendNative() external payable onlyToken { require(_isNativeReward(), "not native reward"); _fundTokenDividendManual(msg.value); }
    function notifyTokenDividendToken(uint256 amount) external onlyToken { require(!_isNativeReward(), "native reward"); _fundTokenDividendManual(amount); }
    function notifyLPDividendNative() external payable onlyToken { require(_isNativeReward(), "not native reward"); _fundLPDividendManual(msg.value); }
    function notifyLPDividendToken(uint256 amount) external onlyToken { require(!_isNativeReward(), "native reward"); _fundLPDividendManual(amount); }
    function fundTokenDividendBNB() external payable onlyOwner { require(_isNativeReward(), "not native reward"); _fundTokenDividendManual(msg.value); }
    function fundTokenDividendToken(uint256 amount) public onlyOwner { require(!_isNativeReward(), "native reward"); IERC20(rewardTokenAddress()).safeTransferFrom(msg.sender, address(this), amount); _fundTokenDividendManual(amount); }
    function fundLPDividendBNB() external payable onlyOwner { require(_isNativeReward(), "not native reward"); _fundLPDividendManual(msg.value); }
    function fundLPDividendToken(uint256 amount) public onlyOwner { require(!_isNativeReward(), "native reward"); IERC20(rewardTokenAddress()).safeTransferFrom(msg.sender, address(this), amount); _fundLPDividendManual(amount); }

    function _fundTokenDividendManual(uint256 amount) internal {
        uint256 circulating = eligibleTokenDividendSupply();
        require(circulating > 0, "no circulating supply");
        dividendReserve += amount;
        tokenDividendPerShare += amount * ACC / circulating;
        emit TokenDividendFunded(amount);
    }

    function _fundLPDividendManual(uint256 amount) internal {
        uint256 lpSupply = eligibleLPDividendSupply();
        require(lpSupply > 0, "no lp supply");
        dividendReserve += amount;
        lpDividendPerShare += amount * ACC / lpSupply;
        emit LPDividendFunded(amount);
    }

    function pendingTokenDividend(address user) public view returns (uint256) {
        if (excludedMap[user]) return 0;
        uint256 pending = tokenDividendCredit[user];
        uint256 balance = _tokenBalance(user);
        if (balance < minTokenDividendBalance) return pending;
        uint256 accumulated = balance * tokenDividendPerShare / ACC;
        if (accumulated > tokenDividendDebt[user]) pending += accumulated - tokenDividendDebt[user];
        return pending;
    }

    function pendingLPDividend(address user) public view returns (uint256) {
        if (excludedMap[user] || lpDividendDisqualified[user]) return 0;
        uint256 entitlement = mintLPEntitlement[user];
        if (entitlement == 0 || _lpBalance(user) < entitlement) return 0;
        uint256 accumulated = entitlement * lpDividendPerShare / ACC;
        if (accumulated <= lpDividendDebt[user]) return 0;
        return accumulated - lpDividendDebt[user];
    }

    function claimDividends() external nonReentrant {
        require(!excludedMap[msg.sender], "dividend excluded");
        _validateLP(msg.sender);
        uint256 tokenReward = pendingTokenDividend(msg.sender);
        uint256 lpReward = pendingLPDividend(msg.sender);
        uint256 reward = tokenReward + lpReward;
        tokenDividendCredit[msg.sender] = 0;
        tokenDividendDebt[msg.sender] = _tokenBalance(msg.sender) * tokenDividendPerShare / ACC;
        lpBalanceSnapshot[msg.sender] = _lpBalance(msg.sender);
        lpDividendDebt[msg.sender] = mintLPEntitlement[msg.sender] * lpDividendPerShare / ACC;
        if (reward > 0) {
            require(dividendReserve >= reward, "dividend reserve");
            dividendReserve -= reward;
            _sendReward(msg.sender, reward);
        }
        emit DividendClaimed(msg.sender, tokenReward, lpReward);
    }

    function syncLPDividendDebt() external {
        _validateLP(msg.sender);
        if (excludedMap[msg.sender]) {
            lpBalanceSnapshot[msg.sender] = 0;
            lpDividendDebt[msg.sender] = 0;
            return;
        }
        lpBalanceSnapshot[msg.sender] = _lpBalance(msg.sender);
        lpDividendDebt[msg.sender] = mintLPEntitlement[msg.sender] * lpDividendPerShare / ACC;
    }

    function _accrueTokenDividend(address user) internal {
        if (user == address(0)) return;
        if (excludedMap[user]) {
            tokenDividendCredit[user] = 0;
            tokenDividendDebt[user] = 0;
            return;
        }
        uint256 pending = pendingTokenDividend(user);
        if (pending > tokenDividendCredit[user]) tokenDividendCredit[user] = pending;
        tokenDividendDebt[user] = _tokenBalance(user) * tokenDividendPerShare / ACC;
    }

    function _settleTokenDividend(address user) internal {
        if (user == address(0)) return;
        tokenDividendDebt[user] = excludedMap[user] ? 0 : _tokenBalance(user) * tokenDividendPerShare / ACC;
    }

    function _trackDividendHolder(address user) internal {
        if (user == address(0) || excludedMap[user] || isDividendHolder[user]) return;
        uint256 bal = _tokenBalance(user);
        if ((bal > 0 && bal >= minTokenDividendBalance) || (mintLPEntitlement[user] > 0 && !lpDividendDisqualified[user])) {
            isDividendHolder[user] = true;
            dividendHolders.push(user);
        }
    }

    function processAutoDividends(uint256 maxCount) external onlyToken {
        if (autoDividendEnabled) _processAutoDividends(maxCount);
    }

    function _processAutoDividends(uint256 maxCount) internal {
        uint256 total = dividendHolders.length;
        if (total == 0 || maxCount == 0 || dividendReserve == 0) return;
        uint256 processed;
        uint256 paid;
        uint256 iterations;
        while (processed < maxCount && iterations < total && dividendReserve > 0) {
            if (dividendProcessIndex >= total) dividendProcessIndex = 0;
            address user = dividendHolders[dividendProcessIndex];
            dividendProcessIndex += 1;
            iterations += 1;
            if (excludedMap[user]) continue;
            _validateLP(user);
            bool tokenEligible = _tokenBalance(user) >= minTokenDividendBalance;
            bool lpEligible = mintLPEntitlement[user] > 0 && !lpDividendDisqualified[user];
            if (!tokenEligible && !lpEligible) continue;
            uint256 tokenReward = pendingTokenDividend(user);
            uint256 lpReward = pendingLPDividend(user);
            uint256 reward = tokenReward + lpReward;
            if (reward == 0 || reward > dividendReserve) continue;
            if (_trySendReward(user, reward)) {
                tokenDividendCredit[user] = 0;
                tokenDividendDebt[user] = _tokenBalance(user) * tokenDividendPerShare / ACC;
                lpBalanceSnapshot[user] = _lpBalance(user);
                lpDividendDebt[user] = mintLPEntitlement[user] * lpDividendPerShare / ACC;
                dividendReserve -= reward;
                paid += reward;
                processed += 1;
                emit DividendClaimed(user, tokenReward, lpReward);
            }
        }
        if (processed > 0) emit AutoDividendProcessed(processed, paid);
    }

    function _sendReward(address to, uint256 amount) internal {
        if (amount == 0) return;
        if (_isNativeReward()) payable(to).transfer(amount);
        else IERC20(rewardTokenAddress()).safeTransfer(to, amount);
    }

    function _trySendReward(address to, uint256 amount) internal returns (bool) {
        if (amount == 0) return true;
        if (_isNativeReward()) { (bool ok,) = payable(to).call{value: amount, gas: 30000}(""); return ok; }
        (bool success, bytes memory data) = rewardTokenAddress().call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        return success && (data.length == 0 || abi.decode(data, (bool)));
    }

    function _isCoreDividendExcluded(address user) internal view returns (bool) {
        return user == address(0) || user == deadWallet || user == address(this) || user == token || user == pair || user == router;
    }

    function _validateLP(address user) internal {
        uint256 requiredBalance = mintLPEntitlement[user];
        if (requiredBalance > 0 && !lpDividendDisqualified[user]) {
            uint256 actualBalance = _lpBalance(user);
            if (actualBalance < requiredBalance) _disqualifyLP(user, actualBalance);
        }
    }

    function _disqualifyLP(address user, uint256 actualBalance) internal {
        if (lpDividendDisqualified[user]) return;
        uint256 requiredBalance = mintLPEntitlement[user];
        lpDividendDisqualified[user] = true;
        if (requiredBalance >= eligibleMintLPSupply) eligibleMintLPSupply = 0;
        else eligibleMintLPSupply -= requiredBalance;
        lpDividendDebt[user] = 0;
        lpBalanceSnapshot[user] = actualBalance;
        emit LPDividendDisqualified(user, requiredBalance, actualBalance);
    }

    function _setExcludedFromDividends(address user, bool v) internal {
        if (excludedMap[user] == v) return;
        if (v) {
            if (mintLPEntitlement[user] > 0) _disqualifyLP(user, _lpBalance(user));
            excludedMap[user] = true;
            tokenDividendCredit[user] = 0;
            tokenDividendDebt[user] = 0;
            lpBalanceSnapshot[user] = 0;
            lpDividendDebt[user] = 0;
            if (!exclusionKnown[user]) { exclusionKnown[user] = true; dividendExcludedAddresses.push(user); }
        } else {
            excludedMap[user] = false;
            tokenDividendDebt[user] = _tokenBalance(user) * tokenDividendPerShare / ACC;
            lpBalanceSnapshot[user] = _lpBalance(user);
            lpDividendDebt[user] = mintLPEntitlement[user] * lpDividendPerShare / ACC;
        }
    }

    function setExcludedFromDividends(address user, bool v) external onlyOwner {
        if (!v) require(!_isCoreDividendExcluded(user), "core dividend exclusion");
        _setExcludedFromDividends(user, v);
    }

    function batchSetExcludedFromDividends(address[] calldata users, bool v) external onlyOwner {
        for (uint256 i; i < users.length; i++) {
            if (!v) require(!_isCoreDividendExcluded(users[i]), "core dividend exclusion");
            _setExcludedFromDividends(users[i], v);
        }
    }

    function setRewardToken(address v) external onlyOwner {
        require(dividendReserve == 0, "reserve not empty");
        require(v != token, "bad reward token");
        rewardToken = v;
    }

    function setMinTokenDividendBalance(uint256 v) external onlyOwner { minTokenDividendBalance = v; }
    function setAutoDividendEnabled(bool v) external onlyOwner { autoDividendEnabled = v; }
    function setAutoDividendBatchSize(uint256 v) external onlyOwner { require(v > 0 && v <= 20, "bad batch"); autoDividendBatchSize = v; }

    function withdrawDividendReserve(uint256 amount) external onlyOwner {
        uint256 toSend = amount == 0 ? dividendReserve : amount;
        require(toSend <= dividendReserve, "exceeds reserve");
        dividendReserve -= toSend;
        _sendReward(owner(), toSend);
    }

    receive() external payable {}
}`;

const EXTERNAL_DIVIDEND_MINT_BLOCK = String.raw`    receive() external payable nonReentrant whenNotPaused { if (msg.sender == address(router)) return; _mintBNB(msg.sender, msg.value); }
    function decimals() public pure override returns (uint8) { return 18; }
    function dividendMode() external pure returns (uint8) { return 1; }
    function activeDividendContract() external view returns (address) { return dividendDistributor != address(0) ? dividendDistributor : address(this); }
    function _distributorReady() internal view returns (bool) { return externalDividendDistributorEnabled && dividendDistributor != address(0); }
    function _distributor() internal view returns (IFairMintDividendDistributor) { return IFairMintDividendDistributor(dividendDistributor); }
    function rewardTokenAddress() public view returns (address) { return _distributorReady() ? _distributor().rewardTokenAddress() : (rewardToken == address(0) ? (mintMode == MintMode.BNB ? address(0) : usdtAddress) : rewardToken); }
    function dividendReserveView() external view returns (uint256) { return _distributorReady() ? _distributor().dividendReserve() : 0; }
    function minTokenDividendBalanceView() external view returns (uint256) { return _distributorReady() ? _distributor().minTokenDividendBalance() : minTokenDividendBalance; }
    function autoDividendEnabledView() external view returns (bool) { return _distributorReady() ? _distributor().autoDividendEnabled() : autoDividendEnabled; }
    function autoDividendBatchSizeView() external view returns (uint256) { return _distributorReady() ? _distributor().autoDividendBatchSize() : autoDividendBatchSize; }
    function processPendingDividends() external { if (_distributorReady()) _distributor().processAutoDividends(autoDividendBatchSize); }
    function isDividendExcluded(address user) external view returns (bool) { return _distributorReady() ? _distributor().isExcludedFromDividends(user) : false; }
    function dividendExcludedCount() external view returns (uint256) { return _distributorReady() ? _distributor().dividendExcludedCount() : 0; }
    function dividendHolderCount() external view returns (uint256) { return _distributorReady() ? _distributor().dividendHolderCount() : 0; }
    function eligibleTokenDividendSupply() public view returns (uint256) { return _distributorReady() ? _distributor().eligibleTokenDividendSupply() : totalSupply(); }
    function eligibleLPDividendSupply() public view returns (uint256) { return _distributorReady() ? _distributor().eligibleLPDividendSupply() : 0; }
    function pendingTokenDividend(address user) public view returns (uint256) { return _distributorReady() ? _distributor().pendingTokenDividend(user) : 0; }
    function pendingLPDividend(address user) public view returns (uint256) { return _distributorReady() ? _distributor().pendingLPDividend(user) : 0; }
    function claimDividends() external nonReentrant { require(_distributorReady(), "distributor not set"); _distributor().claimDividends(); }
    function syncLPDividendDebt() external { if (_distributorReady()) _distributor().syncLPDividendDebt(); }
    function setDividendDistributor(address distributor, bool enabled) external onlyOwner { dividendDistributor = distributor; externalDividendDistributorEnabled = enabled && distributor != address(0); }
    function setExcludedFromDividends(address user, bool v) external onlyOwner { require(_distributorReady(), "distributor not set"); _distributor().setExcludedFromDividends(user, v); }
    function batchSetExcludedFromDividends(address[] calldata users, bool v) external onlyOwner { require(_distributorReady(), "distributor not set"); _distributor().batchSetExcludedFromDividends(users, v); }
    function setMinTokenDividendBalance(uint256 v) external onlyOwner { minTokenDividendBalance = v; if (_distributorReady()) _distributor().setMinTokenDividendBalance(v); }
    function setAutoDividendEnabled(bool v) external onlyOwner { autoDividendEnabled = v; if (_distributorReady()) _distributor().setAutoDividendEnabled(v); }
    function setAutoDividendBatchSize(uint256 v) external onlyOwner { autoDividendBatchSize = v; if (_distributorReady()) _distributor().setAutoDividendBatchSize(v); }
    function fundTokenDividendBNB() external payable onlyOwner { require(_isNativeReward(), "not native reward"); require(_distributorReady(), "distributor not set"); _distributor().notifyTokenDividendNative{value: msg.value}(); _kickAutoDividends(); }
    function fundTokenDividendToken(uint256 amount) public onlyOwner { require(!_isNativeReward(), "native reward"); require(_distributorReady(), "distributor not set"); IERC20(rewardTokenAddress()).safeTransferFrom(msg.sender, dividendDistributor, amount); _distributor().notifyTokenDividendToken(amount); _kickAutoDividends(); }
    function fundTokenDividendUSDT(uint256 amount) external onlyOwner { require(rewardTokenAddress() == usdtAddress, "not USDT reward"); fundTokenDividendToken(amount); }
    function fundLPDividendBNB() external payable onlyOwner { require(_isNativeReward(), "not native reward"); require(_distributorReady(), "distributor not set"); _distributor().notifyLPDividendNative{value: msg.value}(); _kickAutoDividends(); }
    function fundLPDividendToken(uint256 amount) public onlyOwner { require(!_isNativeReward(), "native reward"); require(_distributorReady(), "distributor not set"); IERC20(rewardTokenAddress()).safeTransferFrom(msg.sender, dividendDistributor, amount); _distributor().notifyLPDividendToken(amount); _kickAutoDividends(); }
    function fundLPDividendUSDT(uint256 amount) external onlyOwner { require(rewardTokenAddress() == usdtAddress, "not USDT reward"); fundLPDividendToken(amount); }
    function withdrawDividendReserve(uint256 amount) external onlyOwner { require(_distributorReady(), "distributor not set"); _distributor().withdrawDividendReserve(amount); }
    function setRewardToken(address v) external onlyOwner { rewardToken = v; if (_distributorReady()) _distributor().setRewardToken(v); }
    function setDividendTargetMode(uint8 v) external onlyOwner { dividendTargetMode = v; }
    function _externalSyncBefore(address user) internal { if (_distributorReady() && user != address(0)) _distributor().syncBefore(user); }
    function _externalSyncAfter(address user) internal { if (_distributorReady() && user != address(0)) _distributor().syncAfter(user); }
    function _isNativeReward() internal view returns (bool) { return rewardTokenAddress() == address(0); }
    function _baseToken() internal view returns (address) { return mintMode == MintMode.BNB ? address(0) : usdtAddress; }
    function mintBNB() external payable nonReentrant whenNotPaused { _mintBNB(msg.sender, msg.value); }
    function _mintBNB(address user, uint256 amount) internal { require(mintMode == MintMode.BNB, "not BNB mode"); require(amount == mintPrice, "bad BNB amount"); _mintFlow(user, amount); }
    function mintUSDT() external nonReentrant whenNotPaused { require(mintMode == MintMode.USDT, "not USDT mode"); IERC20(usdtAddress).safeTransferFrom(msg.sender, address(this), mintPrice); _mintFlow(msg.sender, mintPrice); }

    function _mintFlow(address user, uint256 paidAmount) internal {
        require(mintEnabled, "mint disabled");
        require(!hasMinted[user], "already minted");
        require(mintedCount < maxMintCount, "mint full");
        if (whitelistEnabled) require(whitelist[user], "not whitelisted");
        hasMinted[user] = true;
        mintedCount += 1;
        uint256 userTokens = userMintMode == UserMintMode.FIXED ? userMintAmount : tokenPerMint * userMintShare / DENOMINATOR;
        uint256 lpTokens = tokenPerMint - userTokens;
        uint256 lpFund = paidAmount * lpFundShare / DENOMINATOR;
        require(balanceOf(address(this)) >= tokenPerMint, "insufficient token reserve");
        if (lpTokens > 0 && lpFund > 0) {
            _approve(address(this), address(router), lpTokens);
            address lpRecipient = mintLPRecipientMode == 1 ? user : owner();
            uint256 lpBalanceBefore = IERC20(pair).balanceOf(lpRecipient);
            uint256 liquidity;
            if (mintMode == MintMode.BNB) (,, liquidity) = router.addLiquidityETH{value: lpFund}(address(this), lpTokens, 0, 0, lpRecipient, block.timestamp);
            else {
                IERC20(usdtAddress).forceApprove(address(router), lpFund);
                (,, liquidity) = router.addLiquidity(address(this), usdtAddress, lpTokens, lpFund, 0, 0, lpRecipient, block.timestamp);
            }
            if (_distributorReady()) _distributor().registerMintLP(lpRecipient, liquidity, lpBalanceBefore);
        }
        if (userTokens > 0) _transfer(address(this), user, userTokens);
        emit Minted(user, paidAmount, userTokens, lpTokens, lpFund);
        if (mintedCount >= maxMintCount) { mintEnabled = false; if (launchMode == LaunchMode.AUTO) _openTrading(); }
    }
`;

const EXTERNAL_DIVIDEND_MINT_DISABLED_BLOCK = String.raw`    receive() external payable { revert("mint disabled"); }
    function decimals() public pure override returns (uint8) { return 18; }
    function dividendMode() external pure returns (uint8) { return 1; }
    function activeDividendContract() external view returns (address) { return dividendDistributor != address(0) ? dividendDistributor : address(this); }
    function _distributorReady() internal view returns (bool) { return externalDividendDistributorEnabled && dividendDistributor != address(0); }
    function _distributor() internal view returns (IFairMintDividendDistributor) { return IFairMintDividendDistributor(dividendDistributor); }
    function rewardTokenAddress() public view returns (address) { return _distributorReady() ? _distributor().rewardTokenAddress() : (rewardToken == address(0) ? (mintMode == MintMode.BNB ? address(0) : usdtAddress) : rewardToken); }
    function dividendReserveView() external view returns (uint256) { return _distributorReady() ? _distributor().dividendReserve() : 0; }
    function minTokenDividendBalanceView() external view returns (uint256) { return _distributorReady() ? _distributor().minTokenDividendBalance() : minTokenDividendBalance; }
    function autoDividendEnabledView() external view returns (bool) { return _distributorReady() ? _distributor().autoDividendEnabled() : autoDividendEnabled; }
    function autoDividendBatchSizeView() external view returns (uint256) { return _distributorReady() ? _distributor().autoDividendBatchSize() : autoDividendBatchSize; }
    function processPendingDividends() external { if (_distributorReady()) _distributor().processAutoDividends(autoDividendBatchSize); }
    function isDividendExcluded(address user) external view returns (bool) { return _distributorReady() ? _distributor().isExcludedFromDividends(user) : false; }
    function dividendExcludedCount() external view returns (uint256) { return _distributorReady() ? _distributor().dividendExcludedCount() : 0; }
    function dividendHolderCount() external view returns (uint256) { return _distributorReady() ? _distributor().dividendHolderCount() : 0; }
    function eligibleTokenDividendSupply() public view returns (uint256) { return _distributorReady() ? _distributor().eligibleTokenDividendSupply() : totalSupply(); }
    function eligibleLPDividendSupply() public view returns (uint256) { return _distributorReady() ? _distributor().eligibleLPDividendSupply() : 0; }
    function pendingTokenDividend(address user) public view returns (uint256) { return _distributorReady() ? _distributor().pendingTokenDividend(user) : 0; }
    function pendingLPDividend(address user) public view returns (uint256) { return _distributorReady() ? _distributor().pendingLPDividend(user) : 0; }
    function claimDividends() external nonReentrant { require(_distributorReady(), "distributor not set"); _distributor().claimDividends(); }
    function syncLPDividendDebt() external { if (_distributorReady()) _distributor().syncLPDividendDebt(); }
    function setDividendDistributor(address distributor, bool enabled) external onlyOwner { dividendDistributor = distributor; externalDividendDistributorEnabled = enabled && distributor != address(0); }
    function setExcludedFromDividends(address user, bool v) external onlyOwner { require(_distributorReady(), "distributor not set"); _distributor().setExcludedFromDividends(user, v); }
    function batchSetExcludedFromDividends(address[] calldata users, bool v) external onlyOwner { require(_distributorReady(), "distributor not set"); _distributor().batchSetExcludedFromDividends(users, v); }
    function setMinTokenDividendBalance(uint256 v) external onlyOwner { minTokenDividendBalance = v; if (_distributorReady()) _distributor().setMinTokenDividendBalance(v); }
    function setAutoDividendEnabled(bool v) external onlyOwner { autoDividendEnabled = v; if (_distributorReady()) _distributor().setAutoDividendEnabled(v); }
    function setAutoDividendBatchSize(uint256 v) external onlyOwner { autoDividendBatchSize = v; if (_distributorReady()) _distributor().setAutoDividendBatchSize(v); }
    function fundTokenDividendBNB() external payable onlyOwner { require(_isNativeReward(), "not native reward"); require(_distributorReady(), "distributor not set"); _distributor().notifyTokenDividendNative{value: msg.value}(); _kickAutoDividends(); }
    function fundTokenDividendToken(uint256 amount) public onlyOwner { require(!_isNativeReward(), "native reward"); require(_distributorReady(), "distributor not set"); IERC20(rewardTokenAddress()).safeTransferFrom(msg.sender, dividendDistributor, amount); _distributor().notifyTokenDividendToken(amount); _kickAutoDividends(); }
    function fundTokenDividendUSDT(uint256 amount) external onlyOwner { require(rewardTokenAddress() == usdtAddress, "not USDT reward"); fundTokenDividendToken(amount); }
    function fundLPDividendBNB() external payable onlyOwner { require(_isNativeReward(), "not native reward"); require(_distributorReady(), "distributor not set"); _distributor().notifyLPDividendNative{value: msg.value}(); _kickAutoDividends(); }
    function fundLPDividendToken(uint256 amount) public onlyOwner { require(!_isNativeReward(), "native reward"); require(_distributorReady(), "distributor not set"); IERC20(rewardTokenAddress()).safeTransferFrom(msg.sender, dividendDistributor, amount); _distributor().notifyLPDividendToken(amount); _kickAutoDividends(); }
    function fundLPDividendUSDT(uint256 amount) external onlyOwner { require(rewardTokenAddress() == usdtAddress, "not USDT reward"); fundLPDividendToken(amount); }
    function withdrawDividendReserve(uint256 amount) external onlyOwner { require(_distributorReady(), "distributor not set"); _distributor().withdrawDividendReserve(amount); }
    function setRewardToken(address v) external onlyOwner { rewardToken = v; if (_distributorReady()) _distributor().setRewardToken(v); }
    function setDividendTargetMode(uint8 v) external onlyOwner { dividendTargetMode = v; }
    function _externalSyncBefore(address user) internal { if (_distributorReady() && user != address(0)) _distributor().syncBefore(user); }
    function _externalSyncAfter(address user) internal { if (_distributorReady() && user != address(0)) _distributor().syncAfter(user); }
    function _isNativeReward() internal view returns (bool) { return rewardTokenAddress() == address(0); }
    function _baseToken() internal view returns (address) { return mintMode == MintMode.BNB ? address(0) : usdtAddress; }
    function mintBNB() external payable { revert("mint disabled"); }
    function _mintBNB(address, uint256) internal pure { revert("mint disabled"); }
    function mintUSDT() external pure { revert("mint disabled"); }
    function _mintFlow(address, uint256) internal pure { revert("mint disabled"); }
`;

const EXTERNAL_DIVIDEND_TAX_BLOCK = String.raw`    function _update(address from, address to, uint256 amount) internal override {
        if (from == address(0) || to == address(0)) { super._update(from, to, amount); return; }
        if (from == pair && !liquidityRemovalEnabled && _isRemovingLiquidity()) revert("LP removal disabled");
        uint256 grossAmount = amount;
        if (!tradingOpen && launchMode == LaunchMode.TIME && launchTime > 0 && block.timestamp >= launchTime) { tradingOpen = true; tradingStartTime = block.timestamp; emit TradingOpened(block.timestamp); }
        bool exemptLimit = isExcludedFromLimits[from] || isExcludedFromLimits[to];
        bool preLaunchBuy = !tradingOpen && from == pair && preLaunchBuyWhitelistEnabled && preLaunchBuyWhitelist[to];
        if (!tradingOpen && !exemptLimit && !preLaunchBuy) revert("trading not open");
        if (!inSwap && swapEnabled && from != pair && from != address(this)) {
            uint256 taxTokenBalance = pendingTaxTokens;
            if (taxTokenBalance >= swapThreshold && swapThreshold > 0) _swapBack(taxTokenBalance);
        }
        uint256 taxAmount = 0;
        if (!inSwap && !isExcludedFromFee[from] && !isExcludedFromFee[to]) {
            uint256 taxRate;
            if (from == pair) taxRate = buyTax;
            else if (to == pair) taxRate = sellTax;
            else taxRate = transferTax;
            if (taxRate > 0) taxAmount = amount * taxRate / DENOMINATOR;
        }
        if (taxAmount > 0) {
            _externalSyncBefore(from);
            _externalSyncBefore(address(this));
            super._update(from, address(this), taxAmount);
            _externalSyncAfter(from);
            _externalSyncAfter(address(this));
            pendingTaxTokens += taxAmount;
            amount -= taxAmount;
        }
        if (from == pair && buyWhitelistEnabled && !preLaunchBuy) require(buyWhitelist[to], "buy whitelist");
        if (buyLimitEnabled && from == pair && !isExcludedFromLimits[to]) { boughtAmount[to] += amount; require(boughtAmount[to] <= maxBuyAmountPerWallet, "buy limit"); }
        if (buyAmountLimitEnabled && from == pair && !isExcludedFromLimits[to]) { boughtBaseAmount[to] += _baseAmountForBuy(grossAmount); require(boughtBaseAmount[to] <= maxBuyBaseAmountPerWallet, "buy amount limit"); }
        _externalSyncBefore(from);
        _externalSyncBefore(to);
        super._update(from, to, amount);
        _externalSyncAfter(from);
        _externalSyncAfter(to);
        _kickAutoDividends();
    }

    function _baseAmountForBuy(uint256 tokenAmountOut) internal view returns (uint256) {
        IPancakePairV2Lite mainPair = IPancakePairV2Lite(pair);
        (uint112 reserve0, uint112 reserve1,) = mainPair.getReserves();
        bool tokenIs0 = mainPair.token0() == address(this);
        uint256 reserveOut = tokenIs0 ? uint256(reserve0) : uint256(reserve1);
        uint256 reserveIn = tokenIs0 ? uint256(reserve1) : uint256(reserve0);
        require(tokenAmountOut > 0 && tokenAmountOut < reserveOut, "bad buy amount");
        return reserveIn * tokenAmountOut * 10000 / ((reserveOut - tokenAmountOut) * 9975) + 1;
    }

    function _baseBalance() internal view returns (uint256) { return mintMode == MintMode.BNB ? address(this).balance : IERC20(usdtAddress).balanceOf(address(this)); }
    function _sendBase(address to, uint256 amount) internal { if (amount == 0) return; if (mintMode == MintMode.BNB) payable(to).transfer(amount); else IERC20(usdtAddress).safeTransfer(to, amount); }
    function _convertBaseToReward(uint256 amount) internal returns (uint256) {
        if (amount == 0) return 0;
        address target = rewardTokenAddress();
        address base = _baseToken();
        if (target == base) return amount;
        uint256 beforeBal = IERC20(target).balanceOf(address(this));
        if (mintMode == MintMode.BNB) {
            address[] memory path = new address[](2);
            path[0] = router.WETH();
            path[1] = target;
            router.swapExactETHForTokensSupportingFeeOnTransferTokens{value: amount}(0, path, address(this), block.timestamp);
        } else {
            IERC20(usdtAddress).forceApprove(address(router), amount);
            address[] memory path = new address[](3);
            path[0] = usdtAddress;
            path[1] = router.WETH();
            path[2] = target;
            router.swapExactTokensForTokensSupportingFeeOnTransferTokens(amount, 0, path, address(this), block.timestamp);
        }
        return IERC20(target).balanceOf(address(this)) - beforeBal;
    }

    function _fundTokenDividendFromSwap(uint256 baseAmount) internal {
        if (baseAmount == 0 || !_distributorReady()) return;
        uint256 rewardAmount = _isNativeReward() ? baseAmount : _convertBaseToReward(baseAmount);
        if (rewardAmount == 0) return;
        if (_isNativeReward()) _distributor().notifyTokenDividendNative{value: rewardAmount}();
        else {
            IERC20(rewardTokenAddress()).safeTransfer(dividendDistributor, rewardAmount);
            _distributor().notifyTokenDividendToken(rewardAmount);
        }
        _kickAutoDividends();
    }

    function _fundLPDividendFromSwap(uint256 baseAmount) internal {
        if (baseAmount == 0 || !_distributorReady()) return;
        uint256 rewardAmount = _isNativeReward() ? baseAmount : _convertBaseToReward(baseAmount);
        if (rewardAmount == 0) return;
        if (_isNativeReward()) _distributor().notifyLPDividendNative{value: rewardAmount}();
        else {
            IERC20(rewardTokenAddress()).safeTransfer(dividendDistributor, rewardAmount);
            _distributor().notifyLPDividendToken(rewardAmount);
        }
        _kickAutoDividends();
    }

    function _kickAutoDividends() internal { if (_distributorReady()) _distributor().processAutoDividends(autoDividendBatchSize); }

    function _swapBack(uint256 tokenAmount) internal lockSwap {
        uint256 totalShare = marketingShare + burnShare + lpShare + dividendShare;
        if (totalShare == 0 || tokenAmount == 0) return;
        if (tokenAmount > pendingTaxTokens) tokenAmount = pendingTaxTokens;
        if (tokenAmount == 0) return;
        pendingTaxTokens -= tokenAmount;
        uint256 burnTokens = tokenAmount * burnShare / totalShare;
        uint256 lpTokens = tokenAmount * lpShare / totalShare;
        uint256 dividendTokens = tokenAmount * dividendShare / totalShare;
        uint256 marketingTokens = tokenAmount - burnTokens - lpTokens - dividendTokens;
        if (burnTokens > 0) super._update(address(this), deadWallet, burnTokens);
        uint256 lpTokenHalf = lpTokens / 2;
        uint256 tokensToSwap = marketingTokens + dividendTokens + lpTokenHalf;
        uint256 received;
        if (tokensToSwap > 0) {
            uint256 beforeBal = _baseBalance();
            _approve(address(this), address(router), tokensToSwap);
            if (mintMode == MintMode.BNB) {
                address[] memory path = new address[](2);
                path[0] = address(this);
                path[1] = router.WETH();
                router.swapExactTokensForETHSupportingFeeOnTransferTokens(tokensToSwap, 0, path, address(this), block.timestamp);
            } else {
                address[] memory path = new address[](2);
                path[0] = address(this);
                path[1] = usdtAddress;
                router.swapExactTokensForTokensSupportingFeeOnTransferTokens(tokensToSwap, 0, path, address(this), block.timestamp);
            }
            received = _baseBalance() - beforeBal;
        }
        if (received > 0) {
            uint256 marketingAmt = received * marketingTokens / tokensToSwap;
            uint256 dividendAmt = received * dividendTokens / tokensToSwap;
            uint256 lpAmt = received - marketingAmt - dividendAmt;
            _sendBase(marketingWallet, marketingAmt);
            if (dividendTargetMode == 1) _fundLPDividendFromSwap(dividendAmt);
            else _fundTokenDividendFromSwap(dividendAmt);
            if (lpAmt > 0 && lpTokenHalf > 0) {
                _approve(address(this), address(router), lpTokenHalf);
                if (mintMode == MintMode.BNB) router.addLiquidityETH{value: lpAmt}(address(this), lpTokenHalf, 0, 0, owner(), block.timestamp);
                else {
                    IERC20(usdtAddress).forceApprove(address(router), lpAmt);
                    router.addLiquidity(address(this), usdtAddress, lpTokenHalf, lpAmt, 0, 0, owner(), block.timestamp);
                }
            }
            _kickAutoDividends();
        }
        emit SwapBack(tokenAmount, received);
    }

    function forceSwapBack() external onlyOwner { _swapBack(pendingTaxTokens); }
`;

const EXTERNAL_DIVIDEND_TAX_DISABLED_BLOCK = String.raw`    function _update(address from, address to, uint256 amount) internal override {
        if (from == address(0) || to == address(0)) { super._update(from, to, amount); return; }
        if (from == pair && !liquidityRemovalEnabled && _isRemovingLiquidity()) revert("LP removal disabled");
        uint256 grossAmount = amount;
        if (!tradingOpen && launchMode == LaunchMode.TIME && launchTime > 0 && block.timestamp >= launchTime) {
            tradingOpen = true;
            tradingStartTime = block.timestamp;
            emit TradingOpened(block.timestamp);
        }
        bool exemptLimit = isExcludedFromLimits[from] || isExcludedFromLimits[to];
        bool preLaunchBuy = !tradingOpen && from == pair && preLaunchBuyWhitelistEnabled && preLaunchBuyWhitelist[to];
        if (!tradingOpen && !exemptLimit && !preLaunchBuy) revert("trading not open");
        if (from == pair && buyWhitelistEnabled && !preLaunchBuy) require(buyWhitelist[to], "buy whitelist");
        if (buyLimitEnabled && from == pair && !isExcludedFromLimits[to]) { boughtAmount[to] += amount; require(boughtAmount[to] <= maxBuyAmountPerWallet, "buy limit"); }
        if (buyAmountLimitEnabled && from == pair && !isExcludedFromLimits[to]) { boughtBaseAmount[to] += _baseAmountForBuy(grossAmount); require(boughtBaseAmount[to] <= maxBuyBaseAmountPerWallet, "buy amount limit"); }
        if (timedBuyLimitEnabled && from == pair && !isExcludedFromLimits[to]) { uint256 timedLimit = _currentTimedBuyLimit(); if (timedLimit > 0) { boughtBaseAmount[to] += _baseAmountForBuy(grossAmount); require(boughtBaseAmount[to] <= timedLimit, "time buy limit"); } }
        _externalSyncBefore(from);
        _externalSyncBefore(to);
        super._update(from, to, amount);
        _externalSyncAfter(from);
        _externalSyncAfter(to);
        _kickAutoDividends();
    }

    function _baseAmountForBuy(uint256 tokenAmountOut) internal view returns (uint256) {
        IPancakePairV2Lite mainPair = IPancakePairV2Lite(pair);
        (uint112 reserve0, uint112 reserve1,) = mainPair.getReserves();
        bool tokenIs0 = mainPair.token0() == address(this);
        uint256 reserveOut = tokenIs0 ? uint256(reserve0) : uint256(reserve1);
        uint256 reserveIn = tokenIs0 ? uint256(reserve1) : uint256(reserve0);
        require(tokenAmountOut > 0 && tokenAmountOut < reserveOut, "bad buy amount");
        return reserveIn * tokenAmountOut * 10000 / ((reserveOut - tokenAmountOut) * 9975) + 1;
    }
    function _currentTimedBuyLimit() internal view returns (uint256) {
        if (!timedBuyLimitEnabled || !tradingOpen || tradingStartTime == 0 || block.timestamp < tradingStartTime) return 0;
        uint256 elapsedMinutes = (block.timestamp - tradingStartTime) / 60;
        for (uint256 i; i < 3; i++) {
            uint256 endMinute = timedBuyLimitMinutes[i];
            uint256 limitAmount = timedBuyLimitAmounts[i];
            if (limitAmount == 0) continue;
            if (endMinute == 0 || elapsedMinutes < endMinute) return limitAmount;
        }
        return 0;
    }

    function _baseBalance() internal view returns (uint256) { return mintMode == MintMode.BNB ? address(this).balance : IERC20(usdtAddress).balanceOf(address(this)); }
    function _sendBase(address to, uint256 amount) internal { if (amount == 0) return; if (mintMode == MintMode.BNB) payable(to).transfer(amount); else IERC20(usdtAddress).safeTransfer(to, amount); }
    function _convertBaseToReward(uint256 amount) internal returns (uint256) { amount; return 0; }
    function _fundTokenDividendFromSwap(uint256) internal {}
    function _fundLPDividendFromSwap(uint256) internal {}
    function _kickAutoDividends() internal { if (_distributorReady()) _distributor().processAutoDividends(autoDividendBatchSize); }
    function _swapBack(uint256) internal pure {}
    function forceSwapBack() external pure {}
`;

function assembleExternalDividendSource(modules = selectedModuleConfig()) {
  let source = LITE_CONTRACT_SOURCE;
  source = replaceRequired(
    source,
    "contract FairMintTokenV1 is ERC20, Ownable, Pausable, ReentrancyGuard {",
    `${EXTERNAL_DIVIDEND_DISTRIBUTOR_SOURCE}\n\ncontract FairMintTokenV1 is ERC20, Ownable, Pausable, ReentrancyGuard {`,
    "external-dividend-prefix"
  );
  source = replaceRequired(
    source,
    LITE_MINT_BLOCK,
    modules.mint ? EXTERNAL_DIVIDEND_MINT_BLOCK : EXTERNAL_DIVIDEND_MINT_DISABLED_BLOCK,
    modules.mint ? "external-dividend-mint" : "external-dividend-nomint"
  );
  source = replaceRequired(
    source,
    LITE_TAX_BLOCK,
    modules.tax ? EXTERNAL_DIVIDEND_TAX_BLOCK : EXTERNAL_DIVIDEND_TAX_DISABLED_BLOCK,
    modules.tax ? "external-dividend-tax" : "external-dividend-notax"
  );
  return source;
}

function assembleLiteContractSource(modules = selectedModuleConfig()) {
  let source = LITE_CONTRACT_SOURCE;
  if (!modules.mint) {
    source = replaceRequired(source, LITE_MINT_BLOCK, LITE_MINT_DISABLED_BLOCK, "lite-mint");
  }
  if (!modules.tax) {
    source = replaceRequired(source, LITE_TAX_BLOCK, LITE_TAX_DISABLED_BLOCK, "lite-tax");
  }
  return source;
}

function assembleTokenContractSource({ modules = selectedModuleConfig(), dividendMode = selectedDividendMode() } = {}) {
  const useExternalDividendSource = modules.dividend || modules.lpDividend;
  const needsFullSource = (modules.dividend || modules.lpDividend) && !useExternalDividendSource;
  const source = useExternalDividendSource
    ? assembleExternalDividendSource(modules)
    : needsFullSource
      ? CONTRACT_SOURCE
      : assembleLiteContractSource(modules);
  const sourceKind = useExternalDividendSource
    ? (modules.lpDividend ? "external-lpdiv" : "external-div")
    : needsFullSource
      ? (modules.lpDividend ? "full-lpdiv" : `full-${dividendMode}`)
      : "lite-core";
  return {
    source,
    sourceKind,
    moduleKey: moduleVariantKey(modules)
  };
}

function selectedSourceKind() {
  return assembleTokenContractSource().sourceKind;
}

function applyTemplatePreset(template = selectedTemplateVersion()) {
  const preset = FEATURE_PRESETS[template] || FEATURE_PRESETS.mintTax;
  setFeatureToggle("featureMint", preset.mint);
  setFeatureToggle("featureTax", preset.tax);
  setFeatureToggle("featureDividend", preset.dividend);
  setFeatureToggle("featureLPDividend", preset.lpDividend);
  setFeatureToggle("featureLimits", preset.limits);
}

function templateContractSource(template = selectedTemplateVersion()) {
  return assembleTokenContractSource().source;
}

function templateSourceVariant(template = selectedTemplateVersion(), dividendMode = selectedDividendMode()) {
  const assembled = assembleTokenContractSource({ modules: selectedModuleConfig(), dividendMode });
  return `${assembled.sourceKind}:${assembled.moduleKey}:${dividendMode}`;
}

function formField(name) {
  return deployFormEl()?.elements?.[name];
}

function selectedTemplateVersion() {
  return formField("templateVersion")?.value || "mintTax";
}

function selectedDividendMode() {
  return selectedModuleConfig().dividend || selectedModuleConfig().lpDividend ? "external" : "internal";
}

function renderFeatureSummary() {
  const modules = selectedModuleConfig();
  const parts = [];
  if (modules.mint) parts.push("Mint 发射");
  if (modules.tax) parts.push("税率/税收");
  if (modules.dividend) parts.push("持币分红");
  if (modules.lpDividend) parts.push("LP 分红");
  if (modules.limits) parts.push("限购/白名单");
  const summary = $("featureSummary");
  if (!summary) return;
  const assembled = assembleTokenContractSource({ modules });
  const sourceKindLabel = assembled.sourceKind.startsWith("lite") ? "轻量源码" : "完整版源码";
  const pendingNotes = [];
  if (modules.dividend && !modules.lpDividend) pendingNotes.push("持币分红暂时仍走完整版");
  if (modules.lpDividend) pendingNotes.push("LP 分红暂时仍走完整版");
  if (modules.limits && modules.dividend) pendingNotes.push("限购 + 分红 的真正源码拆分还在继续");
  const mintNote = modules.mint ? "" : " Mint 已关闭，总代币将直接发到部署钱包，由部署钱包自行加池。";
  const moduleNote = pendingNotes.length ? ` ${pendingNotes.join("；")}。` : "";
  summary.textContent = parts.length
    ? `当前启用：${parts.join("、")}；编译将使用${sourceKindLabel}。${mintNote}${moduleNote}`
    : `当前仅保留基础开盘能力；编译将使用${sourceKindLabel}。${mintNote}${moduleNote}`;
}

function setSelectOptionEnabled(fieldName, optionValue, enabled) {
  const field = formField(fieldName);
  if (!(field instanceof HTMLSelectElement)) return;
  const option = [...field.options].find((item) => item.value === String(optionValue));
  if (option) option.disabled = !enabled;
}

function setFieldDisabled(fieldName, disabled) {
  const field = formField(fieldName);
  if (field) field.disabled = !!disabled;
}

function ensureHintNode(id, parentSelector) {
  let node = $(id);
  if (node) return node;
  const parent = document.querySelector(parentSelector);
  if (!parent) return null;
  node = document.createElement("p");
  node.id = id;
  node.className = "template-summary";
  parent.appendChild(node);
  return node;
}

function syncDeployLimitModeUI(preferredMode = "") {
  const tokenLimitToggle = formField("buyLimitEnabled");
  const tokenLimitInput = formField("maxBuyAmountPerWallet");
  const amountLimitToggle = formField("buyAmountLimitEnabled");
  const amountLimitInput = formField("maxBuyBaseAmountPerWallet");
  const timedLimitToggle = formField("timedBuyLimitEnabled");
  const timedInputs = [
    formField("timedBuyLimitMinute1"),
    formField("timedBuyLimitAmount1"),
    formField("timedBuyLimitMinute2"),
    formField("timedBuyLimitAmount2"),
    formField("timedBuyLimitMinute3"),
    formField("timedBuyLimitAmount3")
  ];
  if (!tokenLimitToggle || !amountLimitToggle || !timedLimitToggle) return;

  const tokenEnabled = parseBool(tokenLimitToggle.value);
  const amountEnabled = parseBool(amountLimitToggle.value);
  const timedEnabled = parseBool(timedLimitToggle.value);

  if ((tokenEnabled ? 1 : 0) + (amountEnabled ? 1 : 0) + (timedEnabled ? 1 : 0) > 1) {
    if (preferredMode === "amount") {
      tokenLimitToggle.value = "false";
      timedLimitToggle.value = "false";
    } else if (preferredMode === "timed") {
      tokenLimitToggle.value = "false";
      amountLimitToggle.value = "false";
    } else {
      amountLimitToggle.value = "false";
      timedLimitToggle.value = "false";
    }
  }

  const finalTokenEnabled = parseBool(tokenLimitToggle.value);
  const finalAmountEnabled = parseBool(amountLimitToggle.value);
  const finalTimedEnabled = parseBool(timedLimitToggle.value);

  if (tokenLimitInput) tokenLimitInput.disabled = !finalTokenEnabled;
  if (amountLimitInput) amountLimitInput.disabled = !finalAmountEnabled;
  timedInputs.forEach((input) => { if (input) input.disabled = !finalTimedEnabled; });

  const hint = ensureHintNode("deployLimitModeHint", "#limitsSection");
  if (hint) {
    hint.textContent = finalTokenEnabled
      ? "当前使用代币数量限购。"
      : finalAmountEnabled
        ? "当前使用固定金额限购。"
        : finalTimedEnabled
          ? "当前使用时间金额限购，按开盘后的分钟分档限制买入金额。"
          : "代币限购、金额限购、时间金额限购三选一，也可以全部关闭。";
  }
}

function syncAdminLimitModeUI(preferredMode = "") {
  const tokenLimitToggle = $("buyLimitEnabled");
  const tokenLimitInput = $("maxBuyAmountPerWallet");
  const amountLimitToggle = $("buyAmountLimitEnabled");
  const amountLimitInput = $("maxBuyBaseAmountPerWallet");
  const timedLimitToggle = $("timedBuyLimitEnabled");
  const timedInputs = [
    $("timedBuyLimitMinute1"),
    $("timedBuyLimitAmount1"),
    $("timedBuyLimitMinute2"),
    $("timedBuyLimitAmount2"),
    $("timedBuyLimitMinute3"),
    $("timedBuyLimitAmount3")
  ];
  if (!tokenLimitToggle || !amountLimitToggle || !timedLimitToggle) return;

  const tokenEnabled = parseBool(tokenLimitToggle.value);
  const amountEnabled = parseBool(amountLimitToggle.value);
  const timedEnabled = parseBool(timedLimitToggle.value);

  if ((tokenEnabled ? 1 : 0) + (amountEnabled ? 1 : 0) + (timedEnabled ? 1 : 0) > 1) {
    if (preferredMode === "amount") {
      tokenLimitToggle.value = "false";
      timedLimitToggle.value = "false";
    } else if (preferredMode === "timed") {
      tokenLimitToggle.value = "false";
      amountLimitToggle.value = "false";
    } else {
      amountLimitToggle.value = "false";
      timedLimitToggle.value = "false";
    }
  }

  const finalTokenEnabled = parseBool(tokenLimitToggle.value);
  const finalAmountEnabled = parseBool(amountLimitToggle.value);
  const finalTimedEnabled = parseBool(timedLimitToggle.value);

  if (tokenLimitInput) tokenLimitInput.disabled = !finalTokenEnabled;
  if (amountLimitInput) amountLimitInput.disabled = !finalAmountEnabled;
  timedInputs.forEach((input) => { if (input) input.disabled = !finalTimedEnabled; });

  const hint = ensureHintNode("adminLimitModeHint", 'article[data-template-feature="limits"]');
  if (hint) {
    hint.textContent = finalTokenEnabled
      ? "当前后台启用的是代币数量限购。"
      : finalAmountEnabled
        ? "当前后台启用的是固定金额限购。"
        : finalTimedEnabled
          ? "当前后台启用的是时间金额限购。"
          : "当前后台未启用买入限购。";
  }
}

function syncDividendModeUI() {
  const dividendMode = formField("dividendMode");
  const dividendOwner = formField("dividendOwner");
  if (!dividendMode) return;
  dividendMode.value = "external";
  const external = true;
  if (dividendOwner) {
    dividendOwner.disabled = !external;
    if (!external) dividendOwner.value = "";
  }
  const hint = ensureHintNode("dividendModeHint", "#taxShareSection");
  if (hint) {
    hint.textContent = external
      ? "当前使用独立分红合约模式，部署时会额外部署 distributor。"
      : "当前使用内置分红模式，不会额外部署独立分红合约。";
  }
}

function applyFeatureSelection() {
  const mintField = formField("featureMint");
  const taxField = formField("featureTax");
  const dividendField = formField("featureDividend");
  const lpDividendField = formField("featureLPDividend");
  const limitsField = formField("featureLimits");
  if (!mintField || !taxField || !dividendField || !lpDividendField || !limitsField) return;

  if (lpDividendField.checked) dividendField.checked = true;
  if (!dividendField.checked) lpDividendField.checked = false;

  const features = selectedFeatureSet();
  const showMint = features.has("mint");
  const showDividend = features.has("dividend");
  const showLPDividend = features.has("lpDividend");
  const showLimits = features.has("limits");

  if (!showMint) {
    if (formField("launchMode")?.value === "2") formField("launchMode").value = "0";
    if (formField("mintPrice")) formField("mintPrice").value = "0";
    if (formField("tokenPerMint")) formField("tokenPerMint").value = "0";
    if (formField("maxMintCount")) formField("maxMintCount").value = "0";
    if (formField("userMintShare")) formField("userMintShare").value = "0";
    if (formField("userMintAmount")) formField("userMintAmount").value = "0";
    if (formField("lpFundShare")) formField("lpFundShare").value = "0";
  }

  if (!features.has("tax")) {
    if (formField("buyTax")) formField("buyTax").value = "0";
    if (formField("sellTax")) formField("sellTax").value = "0";
    if (formField("transferTax")) formField("transferTax").value = "0";
    setTaxShareValue("marketingShare", 100);
    setTaxShareValue("burnShare", 0);
    setTaxShareValue("lpShare", 0);
    setTaxShareValue("dividendShare", 0);
  }

  if (!showDividend) {
    if (formField("dividendMode")) formField("dividendMode").value = "external";
    if (formField("dividendTargetMode")) formField("dividendTargetMode").value = "0";
    if (formField("dividendOwner")) formField("dividendOwner").value = "";
    setTaxShareValue("dividendShare", 0);
  } else if (showLPDividend) {
    if (formField("dividendMode")) formField("dividendMode").value = "external";
    if (formField("dividendTargetMode")) formField("dividendTargetMode").value = "1";
  } else if (formField("dividendTargetMode")?.value === "1") {
    if (formField("dividendMode")) formField("dividendMode").value = "external";
    formField("dividendTargetMode").value = "0";
  }

  setSelectOptionEnabled("dividendTargetMode", "1", showLPDividend);
  setFieldDisabled("dividendMode", true);
  setFieldDisabled("dividendTargetMode", !showDividend);
  setFieldDisabled("dividendOwner", !showDividend);
  setFieldDisabled("rewardToken", !showDividend);
  setFieldDisabled("minTokenDividendBalance", !showDividend);

  if (!showLimits) {
    if (formField("buyLimitEnabled")) formField("buyLimitEnabled").value = "false";
    if (formField("buyAmountLimitEnabled")) formField("buyAmountLimitEnabled").value = "false";
    if (formField("buyWhitelistEnabled")) formField("buyWhitelistEnabled").value = "false";
    if (formField("preLaunchBuyWhitelistEnabled")) formField("preLaunchBuyWhitelistEnabled").value = "false";
  }

  renderFeatureSummary();
  updateUserMintModeUI();
  updateDeployHints();
  syncTaxShareControls();
  syncDeployLimitModeUI();
  syncAdminLimitModeUI();
  syncDividendModeUI();
  applyTemplateVisibility(selectedTemplateVersion(), "deploy");
  applyTemplateVisibility(selectedTemplateVersion(), "admin");
}

function templateStorageKey(address) {
  return `goldlaunch_template_${String(address || "").toLowerCase()}`;
}

function saveTemplateForAddress(address, template) {
  if (!address || !template) return;
  localStorage.setItem(templateStorageKey(address), template);
}

function loadTemplateForAddress(address) {
  if (!address) return "";
  return localStorage.getItem(templateStorageKey(address)) || "";
}

function renderTemplateDescription(template) {
  const config = templateConfig(template);
  const guide = templateGuideConfig(template);
  const recommend = templateRecommendationConfig(template);
  const summary = $("templateSummary");
  const details = $("templateDetails");
  const deployGuide = $("templateDeployGuide");
  const adminGuide = $("templateAdminGuide");
  const recommendGuide = $("templateRecommendGuide");
  const hint = $("templateAdminHint");
  const renderCards = (items = []) => items.map(([title, text]) => (
    `<div class="template-card"><h4>${title}</h4><p>${text}</p></div>`
  )).join("");
  if (summary) {
    summary.innerHTML = `<strong>${config.title}</strong><p>${config.summary}</p>`;
  }
  if (details) {
    details.innerHTML = renderCards(config.details);
  }
  if (deployGuide) {
    deployGuide.innerHTML = renderCards(guide.deploy);
  }
  if (adminGuide) {
    adminGuide.innerHTML = renderCards(guide.admin);
  }
  if (recommendGuide) {
    recommendGuide.innerHTML = renderCards(recommend);
  }
  if (hint) {
    hint.textContent = `${config.title} 已选中：部署页、Mint 页和后台只保留这个版本常用的配置与操作。`;
  }
}

function setTemplateDrivenDefaults(template) {
  const config = templateConfig(template);
  const dividendMode = formField("dividendMode");
  const dividendTargetMode = formField("dividendTargetMode");
  const supportsDividend = config.features.includes("dividend") || config.features.includes("lpDividend");
  if (dividendMode) {
    setSelectOptionEnabled("dividendMode", "external", true);
    dividendMode.value = "external";
  }
  if (dividendTargetMode) {
    if (!supportsDividend) dividendTargetMode.value = "0";
    else if (template === "lpDividend") dividendTargetMode.value = "1";
  }
  setFieldDisabled("dividendMode", true);
  setFieldDisabled("dividendTargetMode", !supportsDividend);
  const buyTax = formField("buyTax");
  const sellTax = formField("sellTax");
  const transferTax = formField("transferTax");
  const marketingShare = formField("marketingShare");
  const marketingShareNumber = formField("marketingShareNumber");
  const dividendShare = formField("dividendShare");
  const dividendShareNumber = formField("dividendShareNumber");
  if (buyTax && sellTax && transferTax && !config.features.includes("tax")) {
    buyTax.value = "0";
    sellTax.value = "0";
    transferTax.value = "0";
  }
  if (dividendShare && dividendShareNumber && !config.features.includes("dividend") && !config.features.includes("lpDividend")) {
    dividendShare.value = "0";
    dividendShareNumber.value = "0";
  }
  if (marketingShare && marketingShareNumber && !config.features.includes("tax")) {
    marketingShare.value = "100";
    marketingShareNumber.value = "100";
  }
}

function applyTemplateVisibility(template, mode = "deploy") {
  const featureSet = selectedFeatureSet();
  const nodes = document.querySelectorAll(mode === "admin" ? ".admin-groups [data-template-feature]" : "#deploy [data-template-feature]");
  nodes.forEach((node) => {
    const required = String(node.dataset.templateFeature || "").split(/\s+/).filter(Boolean);
    const visible = required.length === 0 || required.some((feature) => featureSet.has(feature));
    node.classList.toggle("template-hidden", !visible);
  });
  const claimButton = $("claimDividends");
  const mintButton = $("mintNow");
  if (claimButton && mode !== "admin") {
    const showClaim = featureSet.has("dividend") || featureSet.has("lpDividend");
    claimButton.classList.toggle("template-hidden", !showClaim);
  }
  if (mintButton && mode !== "admin") {
    mintButton.classList.toggle("template-hidden", !featureSet.has("mint"));
  }
  if (mode !== "admin") {
    const mintTab = document.querySelector('.tab[data-tab="mint"]');
    const mintPanel = $("mint");
    const showMintPanel = featureSet.has("mint") || featureSet.has("dividend") || featureSet.has("lpDividend");
    mintTab?.classList.toggle("template-hidden", !showMintPanel);
    mintPanel?.classList.toggle("template-hidden", !showMintPanel);
    if (!showMintPanel && mintPanel?.classList.contains("active")) {
      document.querySelectorAll(".tab,.panel").forEach((el) => el.classList.remove("active"));
      document.querySelector('.tab[data-tab="deploy"]')?.classList.add("active");
      $("deploy")?.classList.add("active");
    }
  }
}

function applyTemplateSelection(template = selectedTemplateVersion()) {
  renderTemplateDescription(template);
  applyTemplatePreset(template);
  setTemplateDrivenDefaults(template);
  applyFeatureSelection();
  const hint = $("templateAdminHint");
  if (hint) {
    const supportsDividend = selectedFeatureSet().has("dividend") || selectedFeatureSet().has("lpDividend");
    const supportsExternalDividend = true;
    const extras = [];
    if (!supportsDividend) extras.push("当前模板不包含分红功能，分红相关配置已禁用。");
    else if (!supportsExternalDividend) extras.push("当前模板不支持独立分红合约，已禁用该选项。");
    if (extras.length) hint.textContent = `${hint.textContent} ${extras.join(" ")}`;
  }
}

function applyTemplateForAddress(address) {
  const stored = loadTemplateForAddress(address);
  if (!stored) return;
  const field = formField("templateVersion");
  if (field) field.value = stored;
  applyTemplateSelection(stored);
}

function percentToBp(value) {
  return BigInt(Math.round(Number(value || 0) * 100));
}

function activeNetworkDefaults() {
  return state.network ? NETWORK_DEFAULTS[Number(state.network.chainId)] : null;
}

function shouldReplaceAddress(input, knownValues) {
  const value = (input.value || "").trim().toLowerCase();
  if (!value) return true;
  return knownValues.filter(Boolean).map((v) => v.toLowerCase()).includes(value);
}

function applyNetworkDefaults(force = false) {
  const defaults = activeNetworkDefaults();
  if (!defaults) {
    updateDeployHints();
    return;
  }
  const router = formField("router");
  const usdt = formField("usdtAddress");
  const knownRouters = Object.values(NETWORK_DEFAULTS).map((n) => n.router);
  const knownUsdt = Object.values(NETWORK_DEFAULTS).map((n) => n.usdt);
  if (router && defaults.router && (force || shouldReplaceAddress(router, knownRouters))) router.value = defaults.router;
  if (usdt && defaults.usdt && (force || shouldReplaceAddress(usdt, knownUsdt))) usdt.value = defaults.usdt;
  updateDeployHints();
}

function setDefaultMarketingWallet(force = false) {
  const marketing = formField("marketingWallet");
  if (marketing && state.account && (force || !marketing.value.trim())) marketing.value = state.account;
}

function formatNumber(value) {
  if (!Number.isFinite(value)) return "0";
  if (value === 0) return "0";
  // Show up to 10 fractional digits, strip trailing zeros
  if (Math.abs(value) < 1 && value !== 0) {
    return value.toFixed(10).replace(/0+$/, '').replace(/\.$/, '');
  }
  return value.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

function formatBigIntRatio(numerator, denominator, precision = 30) {
  if (denominator <= 0n || numerator < 0n) return "-";
  const integer = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder === 0n) return integer.toString();
  const scale = 10n ** BigInt(precision);
  const fraction = (remainder * scale / denominator).toString().padStart(precision, "0").replace(/0+$/, "");
  return fraction ? `${integer}.${fraction}` : integer.toString();
}

function launchPriceDetails(form) {
  const mintPriceRaw = parseToken(form.elements.mintPrice.value);
  const tokenPerMintRaw = parseToken(form.elements.tokenPerMint.value);
  const userMintMode = Number(form.elements.userMintMode.value);
  const userShareBp = percentToBp(form.elements.userMintShare.value);
  const userMintAmountRaw = parseToken(form.elements.userMintAmount.value);
  const lpFundShareBp = percentToBp(form.elements.lpFundShare.value);
  const lpFundRaw = mintPriceRaw * lpFundShareBp / 10000n;
  const userTokenRaw = userMintMode === 1 ? userMintAmountRaw : tokenPerMintRaw * userShareBp / 10000n;
  if (userTokenRaw > tokenPerMintRaw) throw new Error("用户到账数量不能大于单次 Mint 代币数");
  const lpTokenRaw = tokenPerMintRaw - userTokenRaw;
  const defaults = activeNetworkDefaults();
  const currency = Number(form.elements.mintMode.value) === 0 ? (defaults?.native || "BNB") : "USDT";
  return { mintPriceRaw, tokenPerMintRaw, userMintMode, userShareBp, userMintAmountRaw, userTokenRaw, lpFundShareBp, lpFundRaw, lpTokenRaw, currency };
}

function applyTargetLaunchPrice() {
  const form = deployFormEl();
  if (!form) return;
  const targetInput = form.elements.targetLaunchPrice;
  const hint = $("targetLaunchPriceHint");
  const rawValue = String(targetInput.value || "").trim();
  if (!rawValue) { if (hint) hint.textContent = ""; return; }
  try {
    const targetPriceRaw = parseToken(rawValue);
    const mintPriceRaw = parseToken(form.elements.mintPrice.value);
    const userMintMode = Number(form.elements.userMintMode.value);
    const userShareBp = percentToBp(form.elements.userMintShare.value);
    const userMintAmountRaw = parseToken(form.elements.userMintAmount.value);
    const lpFundShareBp = percentToBp(form.elements.lpFundShare.value);
    const lpTokenShareBp = 10000n - userShareBp;
    if (targetPriceRaw <= 0n) throw new Error("目标开盘单价必须大于0");
    if (mintPriceRaw <= 0n || lpFundShareBp <= 0n) throw new Error("进入流动性的资金必须大于0");
    if (userMintMode === 0 && lpTokenShareBp <= 0n) throw new Error("用户拿币比例不能是100%");
    const lpTokenRaw = mintPriceRaw * lpFundShareBp * 10n ** 18n / (targetPriceRaw * 10000n);
    const tokenPerMintRaw = userMintMode === 1
      ? lpTokenRaw + userMintAmountRaw
      : mintPriceRaw * lpFundShareBp * 10n ** 18n / (targetPriceRaw * lpTokenShareBp);
    if (tokenPerMintRaw <= 0n) throw new Error("目标单价过高，无法计算代币数量");
    form.elements.tokenPerMint.value = ethers.formatUnits(tokenPerMintRaw, 18);
    const totalRaw = parseToken(form.elements.totalSupply.value);
    const maxMint = totalRaw / tokenPerMintRaw;
    if (maxMint > 0n) {
      form.elements.maxMintCount.value = maxMint.toString();
      if (hint) { hint.textContent = "已按目标开盘单价计算Mint配置"; hint.classList.remove("error"); hint.classList.add("ok"); }
    } else if (hint) {
      hint.textContent = "总供应量不足以覆盖一份Mint，请先提高总供应量";
      hint.classList.remove("ok");
      hint.classList.add("error");
    }
    updateDeployHints();
  } catch (error) {
    if (hint) { hint.textContent = error.message || String(error); hint.classList.remove("ok"); hint.classList.add("error"); }
  }
}

function updateDeployHints() {
  const form = deployFormEl();
  if (!form) return;
  const total = Number(form.elements.totalSupply.value || 0);
  const perMint = Number(form.elements.tokenPerMint.value || 0);
  const maxMint = Number(form.elements.maxMintCount.value || 0);
  const price = Number(form.elements.mintPrice.value || 0);
  const userMintMode = Number(form.elements.userMintMode.value || 0);
  const userShare = Number(form.elements.userMintShare.value || 0);
  const userMintAmount = Number(form.elements.userMintAmount.value || 0);
  const lpFundShare = Number(form.elements.lpFundShare.value || 0);
  const mintedTokenPlan = perMint * maxMint;
  const remaining = total - mintedTokenPlan;
  const userTokensPerMint = userMintMode === 1 ? userMintAmount : perMint * userShare / 100;
  const lpTokensPerMint = perMint - userTokensPerMint;
  const lpFundPerMint = price * lpFundShare / 100;
  const retainedFundPerMint = price - lpFundPerMint;
  const defaults = activeNetworkDefaults();
  const currency = Number(form.elements.mintMode.value) === 0 ? (defaults?.native || "BNB") : "USDT";
  let launchPrice = "-";
  try {
    const details = launchPriceDetails(form);
    if (details.lpFundRaw > 0n && details.lpTokenRaw > 0n) launchPrice = `${formatBigIntRatio(details.lpFundRaw, details.lpTokenRaw)} ${details.currency}/枚`;
  } catch { /* incomplete form input */ }
  const targetCurrency = $("targetLaunchPriceCurrency");
  if (targetCurrency) targetCurrency.textContent = `${currency}/枚`;
  renderStats("deployHints", [
    ["单次 Mint 代币数", formatNumber(perMint)],
    ["Mint 覆盖代币", formatNumber(mintedTokenPlan)],
    ["合约剩余预留", formatNumber(remaining)],
    ["预计总募集", `${formatNumber(price * maxMint)} ${currency}`],
    ["每次用户获得", formatNumber(userTokensPerMint)],
    ["每次进池代币", formatNumber(lpTokensPerMint)],
    ["每次进池资金", `${formatNumber(lpFundPerMint)} ${currency}`],
    ["每次合约留存资金", `${formatNumber(retainedFundPerMint)} ${currency}`],
    ["预计开盘单价", launchPrice]
  ]);
}

function formatDecimalForInput(value) {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1) return String(Math.floor(value));
  // For sub-1 values: use enough precision, strip trailing zeros, avoid becoming "0"
  let s = value.toFixed(18).replace(/0+$/, "").replace(/\.$/, "");
  // Safety: if all decimal digits are 0 (value < 1e-18), show scientific-like format
  if (s === "0" || s === "") {
    s = value.toExponential(8).replace(/0+$/, "").replace(/\.$/, "");
  }
  return s;
}

function syncMintPlan(changedName) {
  const form = deployFormEl();
  if (!form) return;
  const total = Number(form.elements.totalSupply.value || 0);
  const perMintInput = form.elements.tokenPerMint;
  const maxMintInput = form.elements.maxMintCount;
  const perMint = Number(perMintInput.value || 0);
  const maxMint = Number(maxMintInput.value || 0);

  const safePlanMath = Number.isSafeInteger(total) && Number.isSafeInteger(maxMint);
  if ((changedName === "totalSupply" || changedName === "maxMintCount") && total > 0 && maxMint > 0 && safePlanMath) {
    const exact = total / maxMint;
    perMintInput.value = formatDecimalForInput(exact);
  }
  if (changedName === "tokenPerMint" && total > 0 && perMint > 0 && Number.isSafeInteger(total / perMint)) {
    maxMintInput.value = String(Math.floor(total / perMint));
  }
  updateDeployHints();
}

function updateUserMintModeUI() {
  const form = deployFormEl();
  if (!form) return;
  const fixedMode = Number(form.elements.userMintMode.value) === 1;
  const shareInput = form.elements.userMintShare;
  const amountInput = form.elements.userMintAmount;
  shareInput.disabled = fixedMode;
  shareInput.required = !fixedMode;
  amountInput.disabled = !fixedMode;
  amountInput.required = fixedMode;
  amountInput.setCustomValidity("");
  if (fixedMode) {
    try {
      if (parseToken(amountInput.value) > parseToken(form.elements.tokenPerMint.value)) {
        amountInput.setCustomValidity("用户到账数量不能大于单次 Mint 代币数");
      }
    } catch { /* native form validation handles incomplete values */ }
  }
  const target = form.elements.targetLaunchPrice.value.trim();
  if (target) applyTargetLaunchPrice();
  else updateDeployHints();
}

function parseAddressList(value) {
  const addresses = String(value || "")
    .split(/[\s,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (!addresses.length) throw new Error("请先填写批量地址。");
  return addresses.map((address) => {
    if (!ethers.isAddress(address)) throw new Error(`地址格式不正确：${address}`);
    return ethers.getAddress(address);
  });
}

function readDeployTaxConfig(form) {
  const modules = selectedModuleConfig();
  syncTaxShareControls();
  if (!modules.tax) {
    return {
      buyTax: 0n,
      sellTax: 0n,
      transferTax: 0n,
      marketingShare: 10000n,
      burnShare: 0n,
      lpShare: 0n,
      dividendShare: 0n
    };
  }
  const config = {
    buyTax: percentToBp(form.elements.buyTax.value),
    sellTax: percentToBp(form.elements.sellTax.value),
    transferTax: percentToBp(form.elements.transferTax.value),
    marketingShare: percentToBp(form.elements.marketingShare.value),
    burnShare: percentToBp(form.elements.burnShare.value),
    lpShare: percentToBp(form.elements.lpShare.value),
    dividendShare: modules.dividend ? percentToBp(form.elements.dividendShare.value) : 0n
  };
  if (config.marketingShare + config.burnShare + config.lpShare + config.dividendShare !== 10000n) {
    throw new Error("税收分配四项必须合计 100%。");
  }
  return config;
}

const TAX_SHARE_NAMES = ["marketingShare", "burnShare", "lpShare", "dividendShare"];
const TAX_SHARE_LABELS = {
  marketingShare: "营销钱包",
  burnShare: "代币销毁",
  lpShare: "回流 LP",
  dividendShare: "持币分红"
};

function taxShareValue(name) {
  return Number(formField(name)?.value || 0);
}

function taxShareNumberField(name) {
  return formField(`${name}Number`);
}

function setTaxShareValue(name, value) {
  const range = formField(name);
  const number = taxShareNumberField(name);
  const normalized = Math.max(0, Math.min(100, Math.round(Number(value || 0) * 100) / 100));
  if (range) range.value = String(normalized);
  if (number) number.value = String(normalized);
}

function syncTaxShareControls(changedName = null, rawValue = null) {
  if (changedName) {
    const othersTotal = TAX_SHARE_NAMES
      .filter((name) => name !== changedName)
      .reduce((sum, name) => sum + taxShareValue(name), 0);
    const maxAllowed = Math.max(0, 100 - othersTotal);
    setTaxShareValue(changedName, Math.min(Number(rawValue || 0), maxAllowed));
  }

  const values = Object.fromEntries(TAX_SHARE_NAMES.map((name) => [name, taxShareValue(name)]));
  const total = TAX_SHARE_NAMES.reduce((sum, name) => sum + values[name], 0);
  const remaining = Math.round((100 - total) * 100) / 100;

  for (const name of TAX_SHARE_NAMES) {
    const otherTotal = total - values[name];
    const maxAllowed = Math.max(0, Math.round((100 - otherTotal) * 100) / 100);
    const range = formField(name);
    const number = taxShareNumberField(name);
    if (range) range.max = String(maxAllowed);
    if (number) number.max = String(maxAllowed);
    if (range) range.disabled = maxAllowed === 0 && values[name] === 0;
    if (number) number.disabled = maxAllowed === 0 && values[name] === 0;
  }

  const hint = $("taxShareHint");
  if (hint) {
    const parts = TAX_SHARE_NAMES.map((name) => `${TAX_SHARE_LABELS[name]} ${values[name]}%`);
    hint.textContent = remaining === 0
      ? `税收分配合计 100%：${parts.join(" / ")}`
      : `还剩 ${remaining}% 未分配，四项必须合计 100%。`;
    hint.classList.toggle("ok", remaining === 0);
    hint.classList.toggle("error", remaining !== 0);
  }
}

function readDeployLimitConfig(form) {
  if (!selectedModuleConfig().limits) {
    return {
      enabled: false,
      maxAmount: 0n,
      amountEnabled: false,
      maxBaseAmount: 0n,
      timedEnabled: false,
      timedMinutes: [0n, 0n, 0n],
      timedAmounts: [0n, 0n, 0n],
      whitelistEnabled: false,
      preLaunchWhitelistEnabled: false
    };
  }
  const config = {
    enabled: parseBool(form.elements.buyLimitEnabled.value),
    maxAmount: parseToken(form.elements.maxBuyAmountPerWallet.value),
    amountEnabled: parseBool(form.elements.buyAmountLimitEnabled.value),
    maxBaseAmount: parseToken(form.elements.maxBuyBaseAmountPerWallet.value),
    timedEnabled: parseBool(form.elements.timedBuyLimitEnabled.value),
    timedMinutes: [
      BigInt(form.elements.timedBuyLimitMinute1.value || 0),
      BigInt(form.elements.timedBuyLimitMinute2.value || 0),
      BigInt(form.elements.timedBuyLimitMinute3.value || 0)
    ],
    timedAmounts: [
      parseToken(form.elements.timedBuyLimitAmount1.value),
      parseToken(form.elements.timedBuyLimitAmount2.value),
      parseToken(form.elements.timedBuyLimitAmount3.value)
    ],
    whitelistEnabled: parseBool(form.elements.buyWhitelistEnabled.value),
    preLaunchWhitelistEnabled: parseBool(form.elements.preLaunchBuyWhitelistEnabled.value)
  };
  if (config.enabled && config.amountEnabled) throw new Error("买入限购和金额限购只能二选一，不能同时开启。");
  if (config.enabled && config.maxAmount == 0n) throw new Error("开启限购时，单钱包累计限购代币数必须大于 0。");
  if (config.amountEnabled && config.maxBaseAmount == 0n) throw new Error("开启金额限购时，单钱包累计限购金额必须大于 0。");
  if ((config.enabled ? 1 : 0) + (config.amountEnabled ? 1 : 0) + (config.timedEnabled ? 1 : 0) > 1) throw new Error("代币限购、金额限购、时间金额限购三者只能开启一个。");
  if (config.timedEnabled && config.timedAmounts[0] == 0n) throw new Error("开启时间金额限购时，第 1 档金额必须大于 0。");
  if (Number(config.timedMinutes[1]) > 0 && config.timedMinutes[1] <= config.timedMinutes[0]) throw new Error("时间限购第 2 档分钟必须大于第 1 档。");
  if (Number(config.timedMinutes[2]) > 0 && config.timedMinutes[2] <= config.timedMinutes[1]) throw new Error("时间限购第 3 档分钟必须大于第 2 档。");
  return config;
}

function readVanityConfig(form) {
  const enabled = parseBool(form.elements.vanityEnabled.value);
  const suffix = String(form.elements.vanitySuffix.value || "").trim().toLowerCase().replace(/^0x/, "");
  if (!enabled) return { enabled, suffix: "" };
  if (!suffix) throw new Error("开启尾号定制时，请填写目标尾号。");
  if (!/^[0-9a-f]+$/.test(suffix)) throw new Error("目标尾号只能填写 0-9 或 a-f。");
  if (suffix.length > 5) throw new Error("目标尾号最多建议 5 位，避免浏览器计算过慢。");
  return { enabled, suffix };
}

async function findCreate2Salt(factoryAddress, initCode, suffix) {
  const initCodeHash = ethers.keccak256(initCode);
  const normalizedSuffix = suffix.toLowerCase();
  const max = 10_000_000;
  for (let i = 0; i < max; i++) {
    const salt = ethers.keccak256(ethers.solidityPacked(["address", "uint256"], [state.account, BigInt(i)]));
    const address = ethers.getCreate2Address(factoryAddress, salt, initCodeHash);
    if (address.toLowerCase().endsWith(normalizedSuffix)) return { salt, address, attempts: i + 1 };
    if (i > 0 && i % 50000 === 0) {
      log(`尾号计算中：已尝试 ${i.toLocaleString()} 次...`);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  throw new Error("没有在当前搜索范围内找到目标尾号，请缩短尾号或换一个尾号。");
}

async function applyPostDeploySettings(contract, form) {
  const tax = readDeployTaxConfig(form);
  const limit = readDeployLimitConfig(form);
  const jobs = [
    ["设置买入税", tax.buyTax, () => contract.setBuyTax(tax.buyTax)],
    ["设置卖出税", tax.sellTax, () => contract.setSellTax(tax.sellTax)],
    ["设置转账税", tax.transferTax, () => contract.setTransferTax(tax.transferTax)],
    ["设置税收分配", 1n, () => contract.setTaxShares(tax.marketingShare, tax.burnShare, tax.lpShare, tax.dividendShare)],
    ["设置限购数量", limit.maxAmount, () => contract.setMaxBuyAmountPerWallet(limit.maxAmount)],
    ["设置限购开关", limit.enabled ? 1n : 0n, () => contract.setBuyLimitEnabled(limit.enabled)],
    ["设置金额限购", limit.maxBaseAmount, () => contract.setMaxBuyBaseAmountPerWallet(limit.maxBaseAmount)],
    ["设置金额限购开关", limit.amountEnabled ? 1n : 0n, () => contract.setBuyAmountLimitEnabled(limit.amountEnabled)],
    ["设置买入白名单开关", limit.whitelistEnabled ? 1n : 0n, () => contract.setBuyWhitelistEnabled(limit.whitelistEnabled)],
    ["设置开盘前买入白名单开关", limit.preLaunchWhitelistEnabled ? 1n : 0n, () => contract.setPreLaunchBuyWhitelistEnabled(limit.preLaunchWhitelistEnabled)]
  ];
  for (const [label, value, call] of jobs) {
    if (value > 0n) await txDone(await call(), label);
  }
}

function getInjectedWallet() {
  const eth = window.ethereum;
  const candidates = [
    ...(eth?.providers || []),
    window.tokenpocket?.ethereum,
    window.tp?.ethereum,
    eth
  ].filter(Boolean);
  const metamask = candidates.find((p) => p.isMetaMask);
  const tokenPocket = candidates.find((p) => p.isTokenPocket || p.isTpWallet || p.isTokenPocketWallet);
  return metamask || tokenPocket || candidates[0] || null;
}

function walletHelpText() {
  const url = location.href;
  return [
    "没有检测到钱包插件。",
    "电脑端请用安装了 MetaMask 的 Chrome/Edge 打开本页面。",
    "手机端请在 TokenPocket 或 MetaMask App 内置浏览器打开：",
    url
  ].join("\n");
}

function compileWithWorker(input) {
  const workerCode = `
    import solc from "https://esm.sh/solc@0.8.24";
    self.onmessage = (event) => {
      try {
        const output = solc.compile(JSON.stringify(event.data), {
          import: (path) => ({ error: "Missing import " + path })
        });
        self.postMessage({ ok: true, output });
      } catch (error) {
        self.postMessage({ ok: false, error: error && error.message ? error.message : String(error) });
      }
    };
  `;
  const blob = new Blob([workerCode], { type: "text/javascript" });
  const workerUrl = URL.createObjectURL(blob);
  const worker = new Worker(workerUrl, { type: "module" });
  return new Promise((resolve, reject) => {
    worker.onmessage = (event) => {
      worker.terminate();
      URL.revokeObjectURL(workerUrl);
      if (event.data.ok) resolve(JSON.parse(event.data.output));
      else reject(new Error(event.data.error));
    };
    worker.onerror = (event) => {
      worker.terminate();
      URL.revokeObjectURL(workerUrl);
      reject(new Error(event.message || "Solidity compiler worker failed"));
    };
    worker.postMessage(input);
  });
}

function setBusy(button, busy) {
  if (!button) return;
  button.disabled = busy;
}

async function connectWallet() {
  const injected = getInjectedWallet();
  if (!injected) throw new Error(walletHelpText());
  state.provider = new ethers.BrowserProvider(injected);
  await state.provider.send("eth_requestAccounts", []);
  state.signer = await state.provider.getSigner();
  state.account = await state.signer.getAddress();
  const network = await state.provider.getNetwork();
  state.network = network;
  $("walletAddress").textContent = state.account;
  $("networkName").textContent = `${network.name} / chainId ${network.chainId}`;
  setDefaultMarketingWallet();
  applyNetworkDefaults();
}

function normalizeImport(path) {
  if (path === "@openzeppelin/contracts/security/Pausable.sol") return "@openzeppelin/contracts/utils/Pausable.sol";
  if (path === "@openzeppelin/contracts/security/ReentrancyGuard.sol") return "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
  return path;
}

function resolveImport(importPath, fromPath) {
  const fixed = normalizeImport(importPath);
  if (fixed.startsWith("@openzeppelin/contracts/")) return fixed;
  if (fixed.startsWith("./") || fixed.startsWith("../")) {
    const base = fromPath.split("/").slice(0, -1);
    for (const part of fixed.split("/")) {
      if (part === "." || !part) continue;
      if (part === "..") base.pop();
      else base.push(part);
    }
    return normalizeImport(base.join("/"));
  }
  return fixed;
}

async function fetchSource(path, sources, seen, sourceVariant = "full") {
  if (seen.has(path)) return;
  seen.add(path);
  let content;
  if (path === "FairMintTokenV1.sol") content = templateContractSource(sourceVariant);
  else if (path === "Create2Factory.sol") content = FACTORY_SOURCE;
  else {
    const url = OPENZEPPELIN_BASE + path.replace("@openzeppelin/contracts/", "");
    const res = await fetch(url);
    if (!res.ok) throw new Error(`无法读取依赖：${path}`);
    content = await res.text();
  }
  sources[path] = { content };
  const imports = [...content.matchAll(/import\s+(?:[^"']+from\s+)?["']([^"']+)["'];/g)].map((m) => m[1]);
  for (const item of imports) await fetchSource(resolveImport(item, path), sources, seen, sourceVariant);
}

async function compileContract() {
  log("开始准备编译依赖...");
  const dividendMode = selectedDividendMode();
  const assembled = assembleTokenContractSource({ modules: selectedModuleConfig(), dividendMode });
  const sourceVariant = templateSourceVariant(selectedTemplateVersion(), dividendMode);
  const sources = {};
  await fetchSource("FairMintTokenV1.sol", sources, new Set(), sourceVariant);
  await fetchSource("Create2Factory.sol", sources, new Set(), sourceVariant);
  const input = {
    language: "Solidity",
    sources,
    settings: {
      viaIR: true,
      optimizer: { enabled: true, runs: 1 },
      metadata: { bytecodeHash: "none" },
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } }
    }
  };
  const output = await compileWithWorker(input);
  const errors = (output.errors || []).filter((e) => e.severity === "error");
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join("\n"));
  const contract = output.contracts["FairMintTokenV1.sol"].FairMintTokenV1;
  const distributor = output.contracts["FairMintTokenV1.sol"].FairMintDividendDistributor;
  const factory = output.contracts["Create2Factory.sol"].Create2Factory;
  const creationBytecode = "0x" + contract.evm.bytecode.object;
  const runtimeBytecode = "0x" + (contract.evm.deployedBytecode?.object || "");
  const creationByteSize = hexByteLength(creationBytecode);
  const runtimeByteSize = hexByteLength(runtimeBytecode);
  state.compiled = {
    sourceVariant,
    dividendMode,
    sourceKind: assembled.sourceKind,
    moduleKey: assembled.moduleKey,
    distributorDeployEnabled: assembled.sourceKind.startsWith("external-"),
    abi: contract.abi,
    bytecode: creationBytecode,
    runtimeBytecode,
    creationByteSize,
    runtimeByteSize,
    distributorAbi: distributor?.abi || null,
    distributorBytecode: distributor?.evm?.bytecode?.object ? "0x" + distributor.evm.bytecode.object : null,
    factoryAbi: factory.abi,
    factoryBytecode: "0x" + factory.evm.bytecode.object,
    standardJsonInput: input
  };
  log(`源码组装：${assembled.sourceKind} / ${assembled.moduleKey}`);
  log(`编译完成，ABI ${contract.abi.length} 项，构造参数 ${compiledConstructorTypes().length} 项。`);
  log(`合约大小：创建字节码 ${creationByteSize} bytes / 运行时代码 ${runtimeByteSize} bytes`);
  if (creationByteSize > EVM_MAX_INIT_CODE_SIZE) {
    log(`警告：创建字节码超过 EVM 上限 ${EVM_MAX_INIT_CODE_SIZE} bytes，部署大概率会直接失败。`);
  }
  if (runtimeByteSize > EVM_MAX_RUNTIME_CODE_SIZE) {
    log(`警告：运行时代码超过 EVM 上限 ${EVM_MAX_RUNTIME_CODE_SIZE} bytes，链上会拒绝部署。`);
  }
  return state.compiled;
}

function deployArgs(form) {
  if (!(form instanceof HTMLFormElement)) throw new Error("没有读取到部署表单，请刷新页面后重试。");
  const fd = new FormData(form);
  const tax = readDeployTaxConfig(form);
  const limit = readDeployLimitConfig(form);
  const modules = selectedModuleConfig();
  const launchRaw = fd.get("launchTime");
  const launchTime = launchRaw ? Math.floor(new Date(launchRaw).getTime() / 1000) : 0;
  return [
    fd.get("name"),
    fd.get("symbol"),
    parseToken(fd.get("totalSupply")),
    Number(fd.get("mintMode")),
    fd.get("usdtAddress") || ZERO,
    fd.get("router"),
    parseToken(fd.get("mintPrice")),
    parseToken(fd.get("tokenPerMint")),
    BigInt(fd.get("maxMintCount")),
    Number(fd.get("userMintMode")),
    percentToBp(fd.get("userMintShare")),
    parseToken(fd.get("userMintAmount")),
    percentToBp(fd.get("lpFundShare")),
    Number(fd.get("mintLPRecipientMode") || 0),
    modules.mint ? Number(fd.get("launchMode")) : 0,
    BigInt(launchTime),
    modules.mint,
    fd.get("marketingWallet") || state.account,
    state.account,
    modules.dividend ? (fd.get("rewardToken") || ZERO) : ZERO,
    modules.lpDividend ? 1 : 0,
    tax.buyTax,
    tax.sellTax,
    tax.transferTax,
    tax.marketingShare,
    tax.burnShare,
    tax.lpShare,
    tax.dividendShare,
    limit.enabled,
    limit.maxAmount,
    modules.dividend ? parseToken(fd.get("minTokenDividendBalance")) : 0n,
    limit.amountEnabled,
    limit.maxBaseAmount,
    limit.timedEnabled,
    limit.timedMinutes,
    limit.timedAmounts,
    limit.whitelistEnabled,
    limit.preLaunchWhitelistEnabled
  ];
}

function readDividendMode(form) {
  if (!selectedModuleConfig().dividend) {
    return {
      external: false,
      owner: state.account
    };
  }
  const fd = new FormData(form);
  return {
    external: true,
    owner: (fd.get("dividendOwner") || state.account || "").trim() || state.account
  };
}

async function deployContract(form) {
  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }
  await ensureWallet();
  const requiredVariant = templateSourceVariant();
  if (!state.compiled || state.compiled.sourceVariant !== requiredVariant) await compileContract();
  setDefaultMarketingWallet();
  applyNetworkDefaults();
  const args = deployArgs(form);
  const dividendMode = readDividendMode(form);
  if (dividendMode.external && !state.compiled.distributorDeployEnabled) {
    throw new Error("当前模板未包含独立分红合约，请切换到独立分红版、内置分红版或高级限制版后重新编译。");
  }
  const constructorTypes = compiledConstructorTypes();
  if (constructorTypes.length !== args.length) {
    throw new Error(`构造参数数量不匹配：合约需要 ${constructorTypes.length} 项，网页生成 ${args.length} 项，请刷新后重新编译。`);
  }
  if (state.compiled.creationByteSize > EVM_MAX_INIT_CODE_SIZE) {
    throw new Error(`当前模板编译后的创建字节码为 ${state.compiled.creationByteSize} bytes，超过 EVM 上限 ${EVM_MAX_INIT_CODE_SIZE} bytes，所以会在钱包确认后部署失败。请减少功能，或改成更轻的源码模板。`);
  }
  if (state.compiled.runtimeByteSize > EVM_MAX_RUNTIME_CODE_SIZE) {
    throw new Error(`当前模板编译后的运行时代码为 ${state.compiled.runtimeByteSize} bytes，超过 EVM 上限 ${EVM_MAX_RUNTIME_CODE_SIZE} bytes，链上不允许部署。请减少功能，或改成更轻的源码模板。`);
  }
  const vanity = readVanityConfig(form);
  let contract;
  let address;
  let deploymentHash;
  let factoryAddress = null;
  let vanitySalt = null;
  let distributorAddress = null;
  let distributorHash = null;
  if (vanity.enabled) {
    log("请在钱包中确认 CREATE2 工厂部署交易...");
    const create2Factory = new ethers.ContractFactory(state.compiled.factoryAbi, state.compiled.factoryBytecode, state.signer);
    const deployedFactory = await create2Factory.deploy();
    deploymentHash = deployedFactory.deploymentTransaction().hash;
    log(`工厂部署交易已提交：${deploymentHash}`);
    await deployedFactory.waitForDeployment();
    factoryAddress = await deployedFactory.getAddress();
    log(`工厂部署完成：${factoryAddress}`);
    const encodedArgs = ethers.AbiCoder.defaultAbiCoder().encode(constructorTypes, args).slice(2);
    const initCode = state.compiled.bytecode + encodedArgs;
    log(`开始计算合约尾号：${vanity.suffix}`);
    const found = await findCreate2Salt(factoryAddress, initCode, vanity.suffix);
    vanitySalt = found.salt;
    address = found.address;
    log(`找到目标地址：${address}，尝试 ${found.attempts.toLocaleString()} 次`);
    const tx = await deployedFactory.deploy(vanitySalt, initCode);
    deploymentHash = tx.hash;
    log(`Token 部署交易已提交：${deploymentHash}`);
    await tx.wait();
    contract = new ethers.Contract(address, state.compiled.abi, state.signer);
  } else {
    log("请在钱包中确认部署交易...");
    const tokenFactory = new ethers.ContractFactory(state.compiled.abi, state.compiled.bytecode, state.signer);
    contract = await tokenFactory.deploy(...args);
    deploymentHash = contract.deploymentTransaction().hash;
    log(`部署交易已提交：${deploymentHash}`);
    await contract.waitForDeployment();
    address = await contract.getAddress();
  }
  if (dividendMode.external) {
    const [pair, routerAddress, rewardAddress, deadWallet] = await Promise.all([
      contract.pair(),
      contract.router(),
      contract.rewardTokenAddress(),
      contract.deadWallet()
    ]);
    const distributorFactory = new ethers.ContractFactory(state.compiled.distributorAbi, state.compiled.distributorBytecode, state.signer);
    log("请在钱包中确认独立分红合约部署交易...");
    const distributor = await distributorFactory.deploy(address, pair, routerAddress, rewardAddress, deadWallet, dividendMode.owner, parseToken(form.elements.minTokenDividendBalance.value));
    distributorHash = distributor.deploymentTransaction().hash;
    log(`分红合约部署交易已提交：${distributorHash}`);
    await distributor.waitForDeployment();
    distributorAddress = await distributor.getAddress();
    log(`独立分红合约部署完成：${distributorAddress}`);
    await txDone(await contract.setDividendDistributor(distributorAddress, true), "绑定独立分红合约");
    state.dividendAdmin = distributor;
  } else {
    state.dividendAdmin = null;
  }
  const constructorArgs = ethers.AbiCoder.defaultAbiCoder().encode(constructorTypes, args).slice(2);
  const deploymentInfo = {
    contractAddress: address,
    contractName: "FairMintTokenV1.sol:FairMintTokenV1",
    templateVersion: selectedTemplateVersion(),
    templateTitle: templateConfig(selectedTemplateVersion()).title,
    sourceVariant: state.compiled.sourceVariant,
    compilerVersion: "v0.8.24+commit.e11b9ed9",
    openZeppelinVersion: "5.0.2",
    optimizer: { enabled: true, runs: 1, viaIR: true, bytecodeHash: "none" },
    constructorArguments: constructorArgs,
    constructorValues: args,
    dividendMode,
    dividendDistributor: distributorAddress ? { address: distributorAddress, owner: dividendMode.owner, transactionHash: distributorHash } : null,
    vanity: vanity.enabled ? { factoryAddress, salt: vanitySalt, suffix: vanity.suffix } : null,
    deployer: state.account,
    chainId: (await state.provider.getNetwork()).chainId.toString(),
    transactionHash: deploymentHash,
    deployedAt: new Date().toISOString()
  };
  makeDownload("downloadStandardJson", "verify-standard-json-input.json", jsonSafe(state.compiled.standardJsonInput));
  makeDownload("downloadConstructorArgs", "constructor-args.txt", constructorArgs, "text/plain");
  makeDownload("downloadDeploymentInfo", "deployment-info.json", jsonSafe(deploymentInfo));
  $("verificationBox").hidden = false;
  $("adminContractAddress").value = address;
  $("mintContractAddress").value = address;
  state.admin = await adminContractAt(address);
  state.mint = contract;
  log(`部署完成：${address}`);
  await refreshAdmin();
  await refreshMint();
  saveDeployedToken(address, args);
}

// ── Ave.ai 市场数据抓取（CORS 代理 + API Key 作为 URL 参数）──
const AVE_API_KEY = 'UgbYEGOBtEx8r3uLTxCJPx7sEaYYMvZ6219iLSdYBUIFwbzu3HZ9qMeMprSdkHp9';
async function fetchAndCacheAveData(address) {
  // 尝试多种方式获取 Ave.ai 数据
  const attempts = [
    // 方式1: CORS 代理 + API Key 作为 URL 查询参数
    {
      label: 'corsproxy+key',
      fn: async () => {
        const url = `https://prod.ave-api.com/v2/tokens?keyword=${encodeURIComponent(address)}&chain=bsc&api_key=${AVE_API_KEY}`;
        const proxy = 'https://corsproxy.io/?' + encodeURIComponent(url);
        const res = await fetch(proxy);
        return res.ok ? res.json() : null;
      }
    },
    // 方式2: 另一个 CORS 代理
    {
      label: 'allorigins',
      fn: async () => {
        const url = `https://prod.ave-api.com/v2/tokens?keyword=${encodeURIComponent(address)}&chain=bsc&api_key=${AVE_API_KEY}`;
        const proxy = `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
        const res = await fetch(proxy);
        return res.ok ? res.json() : null;
      }
    },
    // 方式3: 直接请求（部分浏览器/环境可能放行）
    {
      label: 'direct',
      fn: async () => {
        const url = `https://prod.ave-api.com/v2/tokens?keyword=${encodeURIComponent(address)}&chain=bsc`;
        const res = await fetch(url, { headers: { 'X-API-KEY': AVE_API_KEY } });
        return res.ok ? res.json() : null;
      }
    }
  ];

  for (const attempt of attempts) {
    try {
      const data = await attempt.fn();
      if (!data) continue;
      const tokens = data?.data || [];
      const match = Array.isArray(tokens)
        ? tokens.find(t => (t.token || '').toLowerCase() === address.toLowerCase())
        : null;
      if (match) {
        return {
          symbol: match.symbol || '',
          name: match.name || '',
          price_usd: String(match.current_price_usd ?? ''),
          change_24h: String(match.price_change_24h ?? ''),
          volume_24h: String(match.tx_volume_u_24h ?? ''),
          market_cap: String(match.market_cap ?? ''),
          holders: match.holders ?? 0,
          updated_at: Math.floor(Date.now() / 1000)
        };
      }
    } catch (e) { /* try next */ }
  }
  return null;
}

// ── 提示用户一键提交到公开广场 ──
function showAddToPublicLink(address) {
  const link = `https://github.com/Airdr0p-888/gold-launchpad/actions/workflows/add-token.yml`;
  log(`<a href="${link}" target="_blank" style="color:#D4A017;text-decoration:underline;">👉 点此加入公开广场白名单</a>（粘贴合约地址 <b>${address}</b>，点「Run workflow」，约1分钟后代币广场刷新即可看到行情数据）`);
}

// ── 本地存储 ──
function saveDeployedToken(address, args) {
  try {
    const storageKey = 'goldlaunch_local_tokens';
    const existing = JSON.parse(localStorage.getItem(storageKey) || '[]');

    // Avoid duplicates
    if (existing.some(t => t.address && t.address.toLowerCase() === address.toLowerCase())) return;

    const [name, symbol, totalSupply, , , , mintPrice, tokenPerMint, maxMintCount] = args;
    const dec = 18;
    const progress = 0; // Just deployed
    const colors = ['#D4A017','#F5C842','#38BDF8','#34D399','#FB923C','#F472B6','#A78BFA','#22D3EE'];
    const color = colors[Math.floor(Math.random() * colors.length)];

    existing.push({
      rank: 0,
      name: name,
      sym: symbol,
      color: color,
      price: Number(String(mintPrice === 0n ? '0' : ethers.formatUnits(mintPrice, 18))),
      change: 0,
      cap: '--',
      vol: '--',
      progress: 0,
      status: 'live',
      address: address,
      templateVersion: selectedTemplateVersion(),
      templateTitle: templateConfig(selectedTemplateVersion()).title,
      imported: true,
      totalSupply: String(totalSupply === 0n ? '0' : ethers.formatUnits(totalSupply, dec)),
      decimals: dec,
      mintedCount: 0,
      maxMintCount: Number(maxMintCount),
      mintEnabled: true,
      tradingOpen: false
    });

    localStorage.setItem(storageKey, JSON.stringify(existing));
    saveTemplateForAddress(address, selectedTemplateVersion());
    log(`合约信息已保存到本地存储，可在 GOLDLAUNCH 代币广场查看。`);
    // 提示一键提交到公开广场
    showAddToPublicLink(address);
    // 背景抓取 Ave.ai 市场数据（非关键，不影响主流程）
    fetchAndCacheAveData(address).then(cached => {
      if (cached) {
        try {
          const list = JSON.parse(localStorage.getItem(storageKey) || '[]');
          const idx = list.findIndex(t => t.address && t.address.toLowerCase() === address.toLowerCase());
          if (idx >= 0) {
            list[idx].price = Number(cached.price_usd) || list[idx].price;
            list[idx].priceUsd = Number(cached.price_usd) || null;
            list[idx].change = cached.change_24h != null ? Number(cached.change_24h) : 0;
            list[idx].cap = cached.market_cap ? '$' + (Number(cached.market_cap) < 1000 ? Number(cached.market_cap).toFixed(2) : (Number(cached.market_cap)/1000).toFixed(1)+'K') : '--';
            list[idx].vol = cached.volume_24h ? '$' + (Number(cached.volume_24h) < 1000 ? Number(cached.volume_24h).toFixed(2) : (Number(cached.volume_24h)/1000).toFixed(1)+'K') : '--';
            list[idx].hasMarket = true;
            list[idx]._cached = cached;
            localStorage.setItem(storageKey, JSON.stringify(list));
          }
        } catch {}
      }
    });
  } catch (err) {
    // Non-critical, don't block the user
    console.warn('保存合约到本地存储失败:', err);
  }
}

async function ensureWallet() {
  if (!state.signer) await connectWallet();
}

async function contractAt(address) {
  await ensureWallet();
  if (!state.compiled) await compileContract();
  return new ethers.Contract(address, state.compiled.abi, state.signer);
}

async function adminContractAt(address) {
  await ensureWallet();
  return new ethers.Contract(address, ADMIN_TOKEN_ABI, state.signer);
}

async function refreshMint() {
  if (!state.mint) return;
  const reward = await rewardInfo(state.mint);
  const [mintPrice, tokenPerMint, mintedCount, maxMintCount, mintEnabled, mode, pendingToken, pendingLP, reserve] = await Promise.all([
    state.mint.mintPrice(), state.mint.tokenPerMint(), state.mint.mintedCount(), state.mint.maxMintCount(),
    state.mint.mintEnabled(), state.mint.mintMode(), state.mint.pendingTokenDividend(state.account), state.mint.pendingLPDividend(state.account),
    state.mint.dividendReserveView ? state.mint.dividendReserveView() : state.mint.dividendReserve()
  ]);
  renderStats("mintStats", [
    ["Mint 价格", ethers.formatUnits(mintPrice, 18)],
    ["单次代币", ethers.formatUnits(tokenPerMint, 18)],
    ["进度", `${mintedCount} / ${maxMintCount}`],
    ["Mint 状态", mintEnabled ? "开启" : "关闭"],
    ["模式", Number(mode) === 0 ? "BNB" : "USDT"],
    ["分红代币", reward.native ? reward.symbol : `${reward.symbol} ${reward.address}`],
    ["持币可领", `${ethers.formatUnits(pendingToken, reward.decimals)} ${reward.symbol}`],
    ["LP 可领", `${ethers.formatUnits(pendingLP, reward.decimals)} ${reward.symbol}`],
    ["分红储备", `${ethers.formatUnits(reserve, reward.decimals)} ${reward.symbol}`]
  ]);
}

async function refreshAdmin() {
  if (!state.admin) return;
  const reward = await rewardInfo(state.admin);
  const [
    owner, pair, mintMode, mintPrice, tokenPerMint, mintedCount, maxMintCount, mintEnabled, tradingOpen, liquidityRemovalEnabled,
    buyTax, sellTax, transferTax, marketingShare, burnShare, lpShare, dividendShare, dividendTargetMode, marketingWallet, swapThreshold, dividendReserve,
    buyLimitEnabled, maxBuyAmountPerWallet, minTokenDividendBalance, autoDividendEnabled, autoDividendBatchSize, dividendHolderCount,
    buyAmountLimitEnabled, maxBuyBaseAmountPerWallet,
    buyWhitelistEnabled,
    preLaunchBuyWhitelistEnabled,
    dividendExcludedCount, eligibleTokenDividendSupply, eligibleLPDividendSupply,
    taxesLocked, feeExemptionsLocked, pauseDisabledForever, externalDividendDistributorEnabled, dividendDistributor
  ] = await Promise.all([
    readValue(() => state.admin.owner(), ZERO), readValue(() => state.admin.pair(), ZERO), readValue(() => state.admin.mintMode(), 0), readValue(() => state.admin.mintPrice(), 0n), readValue(() => state.admin.tokenPerMint(), 0n),
    readValue(() => state.admin.mintedCount(), 0n), readValue(() => state.admin.maxMintCount(), 0n), readValue(() => state.admin.mintEnabled(), false), readValue(() => state.admin.tradingOpen(), false), readValue(() => state.admin.liquidityRemovalEnabled(), false),
    readValue(() => state.admin.buyTax(), 0n), readValue(() => state.admin.sellTax(), 0n), readValue(() => state.admin.transferTax(), 0n), readValue(() => state.admin.marketingShare(), 0n),
    readValue(() => state.admin.burnShare(), 0n), readValue(() => state.admin.lpShare(), 0n), readValue(() => state.admin.dividendShare(), 0n), readValue(() => state.admin.dividendTargetMode(), 0), readValue(() => state.admin.marketingWallet(), ZERO), readValue(() => state.admin.swapThreshold(), 0n),
    readValue(() => state.admin.dividendReserveView ? state.admin.dividendReserveView() : state.admin.dividendReserve(), 0n), readValue(() => state.admin.buyLimitEnabled(), false), readValue(() => state.admin.maxBuyAmountPerWallet(), 0n), readValue(() => state.admin.minTokenDividendBalanceView ? state.admin.minTokenDividendBalanceView() : state.admin.minTokenDividendBalance(), 0n),
    readValue(() => state.admin.autoDividendEnabledView ? state.admin.autoDividendEnabledView() : state.admin.autoDividendEnabled(), false), readValue(() => state.admin.autoDividendBatchSizeView ? state.admin.autoDividendBatchSizeView() : state.admin.autoDividendBatchSize(), 0n), readValue(() => state.admin.dividendHolderCount(), 0n),
    readValue(() => state.admin.buyAmountLimitEnabled(), false), readValue(() => state.admin.maxBuyBaseAmountPerWallet(), 0n),
    readValue(() => state.admin.buyWhitelistEnabled(), false),
    readValue(() => state.admin.preLaunchBuyWhitelistEnabled(), false),
    readValue(() => state.admin.dividendExcludedCount(), 0n), readValue(() => state.admin.eligibleTokenDividendSupply(), 0n), readValue(() => state.admin.eligibleLPDividendSupply(), 0n),
    readValue(() => state.admin.taxesLocked(), false), readValue(() => state.admin.feeExemptionsLocked(), false), readValue(() => state.admin.pauseDisabledForever(), false),
    readValue(() => state.admin.externalDividendDistributorEnabled(), false), readValue(() => state.admin.dividendDistributor(), ZERO)
  ]);
  state.dividendAdmin = externalDividendDistributorEnabled && dividendDistributor !== ZERO
    ? new ethers.Contract(dividendDistributor, DIVIDEND_DISTRIBUTOR_ABI, state.signer)
    : null;
  renderStats("adminStats", [
    ["Owner", owner], ["Pair", pair], ["Mint 模式", Number(mintMode) === 0 ? "BNB" : "USDT"],
    ["Mint 价格", ethers.formatUnits(mintPrice, 18)], ["单次代币", ethers.formatUnits(tokenPerMint, 18)],
    ["Mint 进度", `${mintedCount} / ${maxMintCount}`], ["Mint", mintEnabled ? "开启" : "关闭"],
    ["交易", tradingOpen ? "已开启" : "未开启"], ["撤除 LP", liquidityRemovalEnabled ? "已永久允许" : "禁止"], ["买/卖/转税", `${buyTax}/${sellTax}/${transferTax} BP`],
    ["分配", `${marketingShare}/${burnShare}/${lpShare}/${dividendShare} BP`], ["营销钱包", marketingWallet],
    ["分红代币", reward.native ? reward.symbol : `${reward.symbol} ${reward.address}`],
    ["Swap 阈值", ethers.formatUnits(swapThreshold, 18)], ["分红储备", `${ethers.formatUnits(dividendReserve, reward.decimals)} ${reward.symbol}`],
    ["买入限购", buyLimitEnabled ? "开启" : "关闭"], ["单钱包限购", ethers.formatUnits(maxBuyAmountPerWallet, 18)],
    ["金额限购", buyAmountLimitEnabled ? "开启" : "关闭"], ["单钱包金额上限", `${ethers.formatUnits(maxBuyBaseAmountPerWallet, 18)} ${Number(mintMode) === 0 ? "BNB" : "USDT"}`],
    ["买入白名单", buyWhitelistEnabled ? "开启" : "关闭"],
    ["开盘前买入白名单", preLaunchBuyWhitelistEnabled ? "开启" : "关闭"],
    ["分红排除地址记录", dividendExcludedCount], ["持币分红有效供应", ethers.formatUnits(eligibleTokenDividendSupply, 18)],
    ["LP分红有效供应", ethers.formatUnits(eligibleLPDividendSupply, 18)],
    ["分红最低持仓", ethers.formatUnits(minTokenDividendBalance, 18)],
    ["自动分红", autoDividendEnabled ? `开启 / 每次 ${autoDividendBatchSize}` : "关闭"], ["分红地址数", dividendHolderCount],
    ["税锁定", taxesLocked ? "已锁定" : "未锁定"], ["免税锁定", feeExemptionsLocked ? "已锁定" : "未锁定"],
    ["暂停权限", pauseDisabledForever ? "永久禁用" : (tradingOpen ? "交易已开，不能暂停" : "可暂停")]
  ]);
  syncAdminLimitModeUI();
}

function renderStats(id, items) {
  $(id).innerHTML = items.map(([k, v]) => `<div class="stat"><span>${k}</span><strong>${v}</strong></div>`).join("");
}

async function mintNow() {
  await ensureWallet();
  if (!state.mint) state.mint = await contractAt($("mintContractAddress").value.trim());
  const contractAddress = await state.mint.getAddress();
  const mode = Number(await state.mint.mintMode());
  const price = await state.mint.mintPrice();
  if (mode === 0) await txDone(await state.mint.mintBNB({ value: price }), "Mint");
  else {
    const usdt = await state.mint.usdtAddress();
    await assertTokenBalance(usdt, state.account, price, "USDT Mint");
    await approveIfNeeded(usdt, contractAddress, price, "USDT Mint");
    await txDone(await state.mint.mintUSDT(), "Mint");
  }
  await refreshMint();
}

async function adminAction(action) {
  await ensureWallet();
  const adminAddress = $("adminContractAddress").value.trim();
  if (!state.admin) state.admin = await adminContractAt(adminAddress);
  if (typeof state.admin.mintMode !== "function") state.admin = await adminContractAt(adminAddress);
  const c = state.admin;
  const contractAddress = await c.getAddress();
  const listAddress = $("listAddress").value.trim();
  const listValue = parseBool($("listValue").value);
  const mode = Number(await c.mintMode());
  const usdt = mode === 1 ? await c.usdtAddress() : ZERO;
  const dividendTarget = await dividendAdminContract(c);
  const dividendTargetAddress = await dividendTarget.getAddress();
  const reward = await rewardInfo(dividendTarget, c);
  const renounceOwnership = async () => {
    if ($("renounceConfirmation").value.trim() !== "RENOUNCE") {
      throw new Error("请输入 RENOUNCE 确认永久丢弃管理员权限");
    }
    const [owner, tradingOpen] = await Promise.all([c.owner(), c.tradingOpen()]);
    if (owner.toLowerCase() !== state.account.toLowerCase()) throw new Error("当前钱包不是合约 Owner");
    if (!tradingOpen) throw new Error("必须先开启交易，才能丢弃管理员权限");
    return c.renounceOwnership();
  };
  const calls = {
    setMintPrice: () => c.setMintPrice(parseToken($("newMintPrice").value)),
    setTokenPerMint: () => c.setTokenPerMint(parseToken($("newTokenPerMint").value)),
    setMaxMintCount: () => c.setMaxMintCount(BigInt($("newMaxMintCount").value)),
    setLaunchTime: () => c.setLaunchTime(BigInt(Math.floor(new Date($("newLaunchTime").value).getTime() / 1000))),
    openTrading: () => c.openTrading(),
    enableLiquidityRemoval: () => c.enableLiquidityRemoval(),
    closeMint: () => c.closeMint(),
    pause: () => c.pause(),
    unpause: () => c.unpause(),
    disablePauseForever: () => c.disablePauseForever(),
    setWhitelistEnabled: () => c.setWhitelistEnabled(parseBool($("whitelistEnabled").value)),
    setWhitelist: () => c.setWhitelist(listAddress, listValue),
    batchSetWhitelist: () => c.batchSetWhitelist(parseAddressList($("batchListAddresses").value), listValue),
    setBuyWhitelistEnabled: () => c.setBuyWhitelistEnabled(parseBool($("buyWhitelistEnabled").value)),
    setBuyWhitelist: () => c.setBuyWhitelist(listAddress, listValue),
    batchSetBuyWhitelist: () => c.batchSetBuyWhitelist(parseAddressList($("batchListAddresses").value), listValue),
    setPreLaunchBuyWhitelistEnabled: () => c.setPreLaunchBuyWhitelistEnabled(parseBool($("preLaunchBuyWhitelistEnabled").value)),
    setPreLaunchBuyWhitelist: () => c.setPreLaunchBuyWhitelist(listAddress, listValue),
    batchSetPreLaunchBuyWhitelist: () => c.batchSetPreLaunchBuyWhitelist(parseAddressList($("batchListAddresses").value), listValue),
    setExcludedFromDividends: () => dividendTarget.setExcludedFromDividends(listAddress, listValue),
    batchSetExcludedFromDividends: () => dividendTarget.batchSetExcludedFromDividends(parseAddressList($("batchListAddresses").value), listValue),
    setExcludedFromFee: () => c.setExcludedFromFee(listAddress, listValue),
    lockFeeExemptions: () => c.lockFeeExemptions(),
    setBuyTax: () => c.setBuyTax(BigInt($("buyTax").value)),
    setSellTax: () => c.setSellTax(BigInt($("sellTax").value)),
    setTransferTax: () => c.setTransferTax(BigInt($("transferTax").value)),
    setTaxShares: () => c.setTaxShares(BigInt($("marketingShare").value), BigInt($("burnShare").value), BigInt($("lpShare").value), BigInt($("dividendShare").value)),
    lockTaxes: () => c.lockTaxes(),
    setMarketingWallet: () => c.setMarketingWallet($("marketingWallet").value.trim()),
    setDividendTargetMode: () => c.setDividendTargetMode(BigInt($("dividendTargetMode").value)),
    setRewardToken: () => dividendTarget.setRewardToken($("rewardTokenAdmin").value.trim() || ZERO),
    setSwapThreshold: () => c.setSwapThreshold(parseToken($("swapThreshold").value)),
    setBuyLimitEnabled: () => c.setBuyLimitEnabled(parseBool($("buyLimitEnabled").value)),
    setMaxBuyAmountPerWallet: () => c.setMaxBuyAmountPerWallet(parseToken($("maxBuyAmountPerWallet").value)),
    setBuyAmountLimitEnabled: () => c.setBuyAmountLimitEnabled(parseBool($("buyAmountLimitEnabled").value)),
    setMaxBuyBaseAmountPerWallet: () => c.setMaxBuyBaseAmountPerWallet(parseToken($("maxBuyBaseAmountPerWallet").value)),
    setTimedBuyLimitEnabled: () => c.setTimedBuyLimitEnabled(parseBool($("timedBuyLimitEnabled").value)),
    setTimedBuyLimitTier1: () => c.setTimedBuyLimitTier(0, BigInt($("timedBuyLimitMinute1").value || 0), parseToken($("timedBuyLimitAmount1").value)),
    setTimedBuyLimitTier2: () => c.setTimedBuyLimitTier(1, BigInt($("timedBuyLimitMinute2").value || 0), parseToken($("timedBuyLimitAmount2").value)),
    setTimedBuyLimitTier3: () => c.setTimedBuyLimitTier(2, BigInt($("timedBuyLimitMinute3").value || 0), parseToken($("timedBuyLimitAmount3").value)),
    setMinTokenDividendBalance: () => dividendTarget.setMinTokenDividendBalance(parseToken($("minTokenDividendBalance").value)),
    setAutoDividendEnabled: () => dividendTarget.setAutoDividendEnabled(parseBool($("autoDividendEnabled").value)),
    setAutoDividendBatchSize: () => dividendTarget.setAutoDividendBatchSize(BigInt($("autoDividendBatchSize").value)),
    processPendingDividends: () => c.processPendingDividends(),
    forceSwapBack: () => c.forceSwapBack(),
    fundTokenDividend: async () => {
      const amount = parseToken($("dividendAmount").value);
      if (reward.native) return dividendTarget.fundTokenDividendBNB({ value: amount });
      await approveIfNeeded(reward.address, dividendTargetAddress, amount, `${reward.symbol} 分红`);
      return dividendTarget.fundTokenDividendToken(amount);
    },
    fundLPDividend: async () => {
      const amount = parseToken($("lpDividendAmount").value);
      if (reward.native) return dividendTarget.fundLPDividendBNB({ value: amount });
      await approveIfNeeded(reward.address, dividendTargetAddress, amount, `${reward.symbol} LP 分红`);
      return dividendTarget.fundLPDividendToken(amount);
    },
    forceAddLiquidity: async () => {
      const tokenAmount = parseToken($("liqTokenAmount").value);
      const fundAmount = parseToken($("liqFundAmount").value);
      if (mode === 0) return c.forceAddLiquidity(tokenAmount, fundAmount, { value: fundAmount });
      await approveIfNeeded(usdt, contractAddress, fundAmount, "USDT 加池");
      return c.forceAddLiquidity(tokenAmount, fundAmount);
    },
    withdrawBNB: () => c.withdrawBNB($("withdrawBNBAmount").value ? parseToken($("withdrawBNBAmount").value) : 0n),
    withdrawToken: () => c.withdrawToken($("withdrawTokenAddress").value.trim(), $("withdrawTokenAmount").value ? parseToken($("withdrawTokenAmount").value) : 0n),
    withdrawDividendReserve: () => dividendTarget.withdrawDividendReserve($("withdrawDividendReserveAmount").value ? parseToken($("withdrawDividendReserveAmount").value) : 0n),
    withdrawLP: () => c.withdrawLP($("withdrawLPAmount").value ? parseToken($("withdrawLPAmount").value) : 0n),
    renounceOwnership
  };
  if (!calls[action]) throw new Error(`未知操作：${action}`);
  await txDone(await calls[action](), action);
  if (action === "renounceOwnership") $("renounceConfirmation").value = "";
  await refreshAdmin();
}

document.querySelectorAll(".tab").forEach((btn) => btn.addEventListener("click", () => {
  document.querySelectorAll(".tab,.panel").forEach((el) => el.classList.remove("active"));
  btn.classList.add("active");
  $(btn.dataset.tab).classList.add("active");
}));

$("connectWallet").addEventListener("click", async (e) => run(e.currentTarget, connectWallet));
$("compileContract").addEventListener("click", async (e) => run(e.currentTarget, compileContract));
$("deployForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  run(e.submitter, () => deployContract(form));
});
$("loadMintInfo").addEventListener("click", async (e) => run(e.currentTarget, async () => { applyTemplateForAddress($("mintContractAddress").value.trim()); state.mint = await contractAt($("mintContractAddress").value.trim()); await refreshMint(); }));
$("mintNow").addEventListener("click", async (e) => run(e.currentTarget, mintNow));
$("claimDividends").addEventListener("click", async (e) => run(e.currentTarget, async () => { if (!state.mint) state.mint = await contractAt($("mintContractAddress").value.trim()); await txDone(await state.mint.claimDividends(), "领取分红"); await refreshMint(); }));
$("loadAdmin").addEventListener("click", async (e) => run(e.currentTarget, async () => {
  const address = $("adminContractAddress").value.trim();
  applyTemplateForAddress(address);
  state.admin = await adminContractAt(address);
  try {
    await refreshAdmin();
    const info = await dividendContractInfo(state.admin);
    if (info.enabled) log(`宸叉娴嬪埌鐙珛鍒嗙孩鍚堢害锛?${info.address}`);
  } catch (error) {
    log(`管理员统计读取部分失败：${error?.shortMessage || error?.message || error}`);
  }
}));
$("refreshAdmin").addEventListener("click", async (e) => run(e.currentTarget, refreshAdmin));
document.querySelectorAll("[data-action]").forEach((btn) => btn.addEventListener("click", async () => run(btn, () => adminAction(btn.dataset.action))));
formField("templateVersion")?.addEventListener("change", (e) => applyTemplateSelection(e.target.value));
["featureMint", "featureTax", "featureDividend", "featureLPDividend", "featureLimits"].forEach((name) => {
  formField(name)?.addEventListener("change", applyFeatureSelection);
});
formField("dividendMode")?.addEventListener("change", () => {
  syncDividendModeUI();
  applyFeatureSelection();
});
formField("buyLimitEnabled")?.addEventListener("change", () => syncDeployLimitModeUI("token"));
formField("buyAmountLimitEnabled")?.addEventListener("change", () => syncDeployLimitModeUI("amount"));
formField("timedBuyLimitEnabled")?.addEventListener("change", () => syncDeployLimitModeUI("timed"));
$("buyLimitEnabled")?.addEventListener("change", () => syncAdminLimitModeUI("token"));
$("buyAmountLimitEnabled")?.addEventListener("change", () => syncAdminLimitModeUI("amount"));
$("timedBuyLimitEnabled")?.addEventListener("change", () => syncAdminLimitModeUI("timed"));
applyTemplateSelection(selectedTemplateVersion());
renderFeatureSummary();
syncDividendModeUI();
syncDeployLimitModeUI();
syncAdminLimitModeUI();

["totalSupply", "tokenPerMint", "maxMintCount", "mintPrice", "userMintShare", "userMintAmount", "lpFundShare"].forEach((name) => {
  const field = formField(name);
  if (!field) return;
  const sync = () => {
    if (["totalSupply", "tokenPerMint", "maxMintCount"].includes(name)) {
      const target = formField("targetLaunchPrice");
      if (target) target.value = "";
      const hint = $("targetLaunchPriceHint");
      if (hint) hint.textContent = "";
    }
    syncMintPlan(name);
    if (["tokenPerMint", "userMintAmount"].includes(name)) updateUserMintModeUI();
    if (["mintPrice", "userMintShare", "lpFundShare"].includes(name) && formField("targetLaunchPrice")?.value.trim()) applyTargetLaunchPrice();
  };
  field.addEventListener("input", sync);
  field.addEventListener("change", sync);
});
formField("targetLaunchPrice")?.addEventListener("input", applyTargetLaunchPrice);
formField("targetLaunchPrice")?.addEventListener("change", applyTargetLaunchPrice);
formField("userMintMode")?.addEventListener("change", updateUserMintModeUI);
TAX_SHARE_NAMES.forEach((name) => {
  formField(name)?.addEventListener("input", (event) => syncTaxShareControls(name, event.target.value));
  taxShareNumberField(name)?.addEventListener("input", (event) => syncTaxShareControls(name, event.target.value));
});
formField("mintMode")?.addEventListener("change", () => {
  applyNetworkDefaults();
  updateDeployHints();
});
window.ethereum?.on?.("chainChanged", () => {
  state.network = null;
  connectWallet().catch((err) => log(err.shortMessage || err.message || String(err)));
});
updateUserMintModeUI();
syncTaxShareControls();

const ERROR_TRANSLATIONS = [
  [/not\s*bnb\s*mode/i, "当前合约是 USDT 模式，不支持 BNB Mint"],
  [/not\s*usdt\s*mode/i, "当前合约是 BNB 模式，不支持 USDT Mint"],
  [/bad\s*bnb\s*amount/i, "发送的 BNB 金额不正确，请检查 Mint 价格"],
  [/mint\s*disabled/i, "Mint 已关闭"],
  [/already\s*minted/i, "该钱包已经 Mint 过了，每个地址限 Mint 一次"],
  [/mint\s*full/i, "Mint 已满/售罄"],
  [/not\s*whitelisted/i, "当前钱包不在白名单中，请联系管理员添加"],
  [/insufficient\s*token\s*reserve/i, "合约内代币储备不足以发放"],
  [/trading\s*not\s*open/i, "交易尚未开启"],
  [/LP\s*removal\s*disabled/i, "当前禁止撤除 LP"],
  [/already\s*enabled/i, "撤除 LP 已经永久允许"],
  [/buy\s*whitelist/i, "当前钱包不在买入白名单中"],
  [/dividend\s*excluded/i, "当前地址已被排除分红"],
  [/core\s*dividend\s*exclusion/i, "核心系统地址的分红排除不能取消"],
  [/buy\s*amount\s*limit/i, "超过单钱包累计买入金额限额"],
  [/buy\s*limit/i, "超过单钱包累计买入代币限额"],
  [/Pausable:\s*paused/i, "合约已暂停"],
  [/Ownable:\s*caller\s*is\s*not\s*the\s*owner/i, "当前钱包不是合约 Owner，无权操作"],
  [/ReentrancyGuard:\s*reentrant\s*call/i, "操作太频繁，请稍后再试"],
  [/ERC20:\s*transfer\s*amount\s*exceeds\s*balance/i, "代币余额不足"],
  [/ERC20:\s*insufficient\s*allowance/i, "代币授权不足，请先授权"],
  [/buy\/transfer\s*tax\s*>\s*5%/i, "买入税或转账税超过 5% 上限"],
  [/sell\s*tax\s*>\s*100%/i, "卖出税超过 100% 上限"],
  [/tax\s*>\s*5%/i, "税率超过 5% 上限"],
  [/sum\s*!=\s*10000/, "税收分配合计不等于 100%"],
  [/lt\s*minted/i, "新最大值不能小于已 Mint 数"],
  [/no\s*available\s*BNB/i, "无可提取的 BNB"],
  [/no\s*available\s*token/i, "无可提取的代币"],
  [/exceeds\s*available/i, "提取数量超过可用余额"],
  [/exceeds\s*reserve/i, "提取数量超过储备"],
  [/no\s*circulating\s*supply/i, "代币无流通供应（全在合约内）"],
  [/no\s*lp\s*supply/i, "无 LP 流动性供应"],
  [/bad\s*BNB/i, "发送的 BNB 金额不正确"],
  [/zero\s*amount/i, "数量不能为 0"],
  // Generic / undecoded
  [/unknown\s*custom\s*error/i, "合约执行失败，请确认操作条件是否满足（如 Mint 是否已关闭/已满，白名单，余额等）"],
];

function translateError(message) {
  for (const [pattern, translation] of ERROR_TRANSLATIONS) {
    if (pattern.test(message)) return translation;
  }
  return null;
}

async function run(button, fn) {
  try {
    setBusy(button, true);
    await fn();
  } catch (err) {
    console.error(err);
    const message = err.shortMessage || err.message || String(err);
    const translated = translateError(message);
    if (translated) {
      log(translated);
    } else if (message.includes("TRANSFER_FROM_FAILED")) {
      log("TRANSFER_FROM_FAILED：通常是 USDT 地址/Router 地址不匹配、USDT 余额不足、授权不足，或当前链不是该 Router 所在网络。请先确认 Mint 模式、USDT 地址、Pancake Router 和钱包网络一致。");
    } else {
      log(message);
    }
  } finally {
    setBusy(button, false);
  }
}
