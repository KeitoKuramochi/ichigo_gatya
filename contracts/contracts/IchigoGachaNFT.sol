// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title IchigoGachaNFT
/// @notice ICHIGOガチャガチャのオンライン参加者向けNFT。ICHIGO/ETHの送金・保管は一切行わず、
/// バックエンドが発行した署名付きバウチャーの検証と、参加者自身のウォレットによるmintのみを扱う。
contract IchigoGachaNFT is ERC1155, Ownable, EIP712 {
    struct ClaimVoucher {
        address wallet; // このアドレス自身がclaimを呼ばない限り無効
        uint256 prizeId; // bridge/prize-pool.js の id と対応
        bytes32 sessionNonce; // 交渉セッションIDから生成、1回しか使えない
        uint256 expiry; // unixタイムスタンプ(秒)。これを過ぎると無効
    }

    bytes32 private constant CLAIM_VOUCHER_TYPEHASH =
        keccak256(
            "ClaimVoucher(address wallet,uint256 prizeId,bytes32 sessionNonce,uint256 expiry)"
        );

    /// @notice バウチャーへの署名だけを行うオフチェーン専用アドレス。資金は一切扱わない。
    address public trustedMinter;

    mapping(bytes32 => bool) public usedNonces;

    event TrustedMinterUpdated(address indexed newTrustedMinter);
    event Claimed(address indexed wallet, uint256 indexed prizeId, bytes32 sessionNonce);

    constructor(string memory uri_, address trustedMinter_)
        ERC1155(uri_)
        Ownable(msg.sender)
        EIP712("IchigoGachaNFT", "1")
    {
        require(trustedMinter_ != address(0), "IchigoGachaNFT: zero trustedMinter");
        trustedMinter = trustedMinter_;
        emit TrustedMinterUpdated(trustedMinter_);
    }

    /// @notice バウチャー署名鍵をローテーションする(漏洩時の緊急対応用)。資金移動は伴わない。
    function setTrustedMinter(address newTrustedMinter) external onlyOwner {
        require(newTrustedMinter != address(0), "IchigoGachaNFT: zero trustedMinter");
        trustedMinter = newTrustedMinter;
        emit TrustedMinterUpdated(newTrustedMinter);
    }

    /// @notice メタデータのベースURIを更新する(画像/JSONのホスト先を後から変更できるように)。
    function setURI(string memory newuri) external onlyOwner {
        _setURI(newuri);
    }

    /// @notice 参加者自身のウォレットから呼ぶ。ガス代は呼び出し者(参加者)が負担する。
    function claim(ClaimVoucher calldata voucher, bytes calldata signature) external {
        require(msg.sender == voucher.wallet, "IchigoGachaNFT: not your voucher");
        require(block.timestamp <= voucher.expiry, "IchigoGachaNFT: voucher expired");
        require(!usedNonces[voucher.sessionNonce], "IchigoGachaNFT: already claimed");

        bytes32 structHash = keccak256(
            abi.encode(
                CLAIM_VOUCHER_TYPEHASH,
                voucher.wallet,
                voucher.prizeId,
                voucher.sessionNonce,
                voucher.expiry
            )
        );
        address signer = ECDSA.recover(_hashTypedDataV4(structHash), signature);
        require(signer == trustedMinter, "IchigoGachaNFT: invalid signature");

        // checks-effects-interactions: mintの前にusedをtrueにする
        usedNonces[voucher.sessionNonce] = true;

        _mint(voucher.wallet, voucher.prizeId, 1, "");
        emit Claimed(voucher.wallet, voucher.prizeId, voucher.sessionNonce);
    }
}
