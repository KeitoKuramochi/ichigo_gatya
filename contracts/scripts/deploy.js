const hre = require("hardhat");

// metadataのベースURI。{id}はウォレット側でzero-padded 64桁hexに置き換えられる(ERC-1155標準)。
// 例: 実際のURLが https://ichigo-gatya.onrender.com/nft-metadata/{id}.json になるよう、
// bridge/server.js側で `/nft-metadata` を静的配信するようにしてから、この値を実URLに差し替えて再デプロイ、
// もしくはデプロイ後に owner の setURI() で更新する。
const BASE_URI =
  process.env.NFT_BASE_URI || "https://ichigo-gatya.onrender.com/nft-metadata/{id}.json";

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) {
    throw new Error(
      "デプロイ用アカウントが見つかりません。.envのDEPLOYER_PRIVATE_KEYを設定してください。"
    );
  }

  // trustedMinter(バウチャー署名者)は、鍵管理を1つに絞るため、今回はデプロイ用アカウントと同一にする。
  const trustedMinter = deployer.address;

  console.log("deployer:", deployer.address);
  console.log("trustedMinter:", trustedMinter);
  console.log("baseURI:", BASE_URI);

  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("deployer balance (wei):", balance.toString());
  if (balance === 0n) {
    throw new Error(
      "デプロイ用アカウントの残高が0です。Optimism上に少額のETHを送金してから実行してください。"
    );
  }

  const Factory = await hre.ethers.getContractFactory("IchigoGachaNFT");
  const contract = await Factory.deploy(BASE_URI, trustedMinter);
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log("IchigoGachaNFT deployed at:", address);
  console.log("");
  console.log("次のステップ:");
  console.log(`1. bridge/.env に NFT_CONTRACT_ADDR=${address} を設定`);
  console.log("2. bridge/.env に ONLINE_MINTER_PRIVATE_KEY=<デプロイに使った秘密鍵> を設定");
  console.log("3. 実際の画像・メタデータが用意でき次第、setURI()で本番URLに更新(必要な場合)");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
