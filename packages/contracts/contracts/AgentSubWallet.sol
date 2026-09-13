// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title AgentSubWallet
/// @notice PROTOTYPE / DEMO CONTRACT - NOT AUDITED, NOT FOR PRODUCTION USE.
///
/// Minimal owner-gated smart-contract wallet standing in for the PRD's
/// ERC-7579 modular smart account (Section 10.1). A real BitGo Agent Wallet
/// sub-wallet would use an audited, standards-based implementation (a
/// Safe/Biconomy/ZeroDev-style ERC-7579 account with installable
/// validator/executor/hook modules) rather than this bespoke contract - the PRD
/// itself (Section 6.10) is explicit that BitGo should adopt/adapt an existing
/// audited implementation rather than ship a custom one for v1.
///
/// This exists only to demonstrate the on-chain deployment step described in
/// apps/backend/src/services/subWalletService.ts (the SendQueue
/// "wallet_deployment" entry) against a real testnet, and to give the backend
/// something real to call `execute()` on. Every governance decision (policy
/// limits, screening, approval) still happens off-chain in the backend
/// (Sections 6.2-6.5) before a call ever reaches this contract - `owner` here
/// is BitGo's signer (services/signer.ts), never the agent itself.
contract AgentSubWallet {
    address public owner;
    string public agentName;
    bool private initialized;

    event Executed(address indexed to, uint256 value, bytes data, bytes result);
    event OwnerChanged(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        require(msg.sender == owner, "AgentSubWallet: not owner");
        _;
    }

    /// @dev Deployed via CREATE2 by AgentSubWalletFactory and initialized in the
    /// same transaction (see AgentSubWalletFactory.deployWallet).
    function initialize(address _owner, string calldata _agentName) external {
        require(!initialized, "AgentSubWallet: already initialized");
        require(_owner != address(0), "AgentSubWallet: zero owner");
        initialized = true;
        owner = _owner;
        agentName = _agentName;
    }

    /// @notice Executes an arbitrary call from this wallet. Restricted to the
    /// owner - stands in for the Pact-gated execute path the backend enforces
    /// off-chain (Section 6.2) before a transaction is ever signed and sent here.
    function execute(address to, uint256 value, bytes calldata data) external onlyOwner returns (bytes memory) {
        (bool success, bytes memory result) = to.call{value: value}(data);
        require(success, "AgentSubWallet: call reverted");
        emit Executed(to, value, data, result);
        return result;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "AgentSubWallet: zero address");
        emit OwnerChanged(owner, newOwner);
        owner = newOwner;
    }

    /// @notice EIP-1271 stub (PRD Section 10.1 - required specifically because
    /// BitGo's custody model is MPC/multi-sig, not a single ECDSA key). This
    /// prototype checks a plain ECDSA recovery against `owner`; a real
    /// implementation would verify against the MPC-derived key instead.
    function isValidSignature(bytes32 hash, bytes memory signature) external view returns (bytes4) {
        if (signature.length == 65 && _recoverSigner(hash, signature) == owner) {
            return 0x1626ba7e; // EIP-1271 magic value
        }
        return 0xffffffff;
    }

    function _recoverSigner(bytes32 hash, bytes memory signature) private pure returns (address) {
        bytes32 r;
        bytes32 s;
        uint8 v;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            r := mload(add(signature, 32))
            s := mload(add(signature, 64))
            v := byte(0, mload(add(signature, 96)))
        }
        if (v < 27) v += 27;
        return ecrecover(hash, v, r, s);
    }

    receive() external payable {}
}
