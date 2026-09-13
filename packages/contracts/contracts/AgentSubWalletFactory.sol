// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./AgentSubWallet.sol";

/// @title AgentSubWalletFactory
/// @notice PROTOTYPE / DEMO CONTRACT - NOT AUDITED, NOT FOR PRODUCTION USE.
///
/// Deploys one AgentSubWallet per agent sub-wallet via CREATE2, mirroring
/// wallet-platform's `AbstractEthLikeWalletDeployer` (Section 6.1 / Section
/// 10.1): a deterministic address computed from (owner, agentName, salt) before
/// deployment, so the backend can predict the address the moment a sub-wallet
/// record is created and simply confirm it once the SendQueue worker's
/// deployment transaction actually lands - see
/// apps/backend/src/services/subWalletService.ts (createSubWallet /
/// completeDeployment).
contract AgentSubWalletFactory {
    event WalletDeployed(address indexed wallet, address indexed owner, string agentName, bytes32 salt);

    function _saltHash(address owner, string calldata agentName, bytes32 salt) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(salt, owner, agentName));
    }

    /// @notice Predicts the address a given (owner, agentName, salt) tuple will
    /// deploy to, before it's deployed.
    function computeAddress(address owner, string calldata agentName, bytes32 salt) external view returns (address) {
        bytes32 initCodeHash = keccak256(type(AgentSubWallet).creationCode);
        bytes32 fullSalt = _saltHash(owner, agentName, salt);
        return
            address(
                uint160(
                    uint256(
                        keccak256(abi.encodePacked(bytes1(0xff), address(this), fullSalt, initCodeHash))
                    )
                )
            );
    }

    /// @notice Deploys and initializes a new AgentSubWallet for one agent
    /// sub-wallet record. Anyone may call this (mirrors a real factory); the
    /// backend is the only caller in practice, gated by everything upstream in
    /// subWalletService.createSubWallet.
    function deployWallet(address owner, string calldata agentName, bytes32 salt) external returns (address wallet) {
        bytes32 fullSalt = _saltHash(owner, agentName, salt);
        wallet = address(new AgentSubWallet{salt: fullSalt}());
        AgentSubWallet(payable(wallet)).initialize(owner, agentName);
        emit WalletDeployed(wallet, owner, agentName, salt);
    }
}
