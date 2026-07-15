const { expect } = require("chai");
const { ethers } = require("hardhat");

async function signVoucher(signer, verifyingContract, chainId, voucher) {
  const domain = {
    name: "IchigoGachaNFT",
    version: "1",
    chainId,
    verifyingContract,
  };
  const types = {
    ClaimVoucher: [
      { name: "wallet", type: "address" },
      { name: "prizeId", type: "uint256" },
      { name: "sessionNonce", type: "bytes32" },
      { name: "expiry", type: "uint256" },
    ],
  };
  return signer.signTypedData(domain, types, voucher);
}

describe("IchigoGachaNFT", function () {
  async function deployFixture() {
    const [deployer, minter, participant, stranger] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("IchigoGachaNFT");
    const contract = await Factory.deploy(
      "https://example.test/nft-metadata/{id}.json",
      minter.address
    );
    await contract.waitForDeployment();
    const address = await contract.getAddress();
    const { chainId } = await ethers.provider.getNetwork();
    return { contract, address, chainId, deployer, minter, participant, stranger };
  }

  function makeVoucher(wallet, overrides = {}) {
    return {
      wallet,
      prizeId: 1,
      sessionNonce: ethers.keccak256(ethers.toUtf8Bytes("session-" + wallet)),
      expiry: Math.floor(Date.now() / 1000) + 24 * 3600,
      ...overrides,
    };
  }

  it("正しいvoucherで、本人がclaimするとmintされる", async function () {
    const { contract, address, chainId, minter, participant } = await deployFixture();
    const voucher = makeVoucher(participant.address);
    const signature = await signVoucher(minter, address, chainId, voucher);

    await expect(contract.connect(participant).claim(voucher, signature))
      .to.emit(contract, "Claimed")
      .withArgs(participant.address, voucher.prizeId, voucher.sessionNonce);

    expect(await contract.balanceOf(participant.address, voucher.prizeId)).to.equal(1n);
  });

  it("同じvoucherを2回claimしようとすると2回目は拒否される(リプレイ拒否)", async function () {
    const { contract, address, chainId, minter, participant } = await deployFixture();
    const voucher = makeVoucher(participant.address);
    const signature = await signVoucher(minter, address, chainId, voucher);

    await contract.connect(participant).claim(voucher, signature);
    await expect(contract.connect(participant).claim(voucher, signature)).to.be.revertedWith(
      "IchigoGachaNFT: already claimed"
    );
  });

  it("voucher.wallet以外のアドレスがclaimしようとすると拒否される(他人のvoucher拒否)", async function () {
    const { contract, address, chainId, minter, participant, stranger } = await deployFixture();
    const voucher = makeVoucher(participant.address);
    const signature = await signVoucher(minter, address, chainId, voucher);

    await expect(contract.connect(stranger).claim(voucher, signature)).to.be.revertedWith(
      "IchigoGachaNFT: not your voucher"
    );
  });

  it("期限切れのvoucherは拒否される", async function () {
    const { contract, address, chainId, minter, participant } = await deployFixture();
    const voucher = makeVoucher(participant.address, {
      expiry: Math.floor(Date.now() / 1000) - 10,
    });
    const signature = await signVoucher(minter, address, chainId, voucher);

    await expect(contract.connect(participant).claim(voucher, signature)).to.be.revertedWith(
      "IchigoGachaNFT: voucher expired"
    );
  });

  it("trustedMinter以外の署名は拒否される", async function () {
    const { contract, address, chainId, participant, stranger } = await deployFixture();
    const voucher = makeVoucher(participant.address);
    // strangerが(trustedMinterでないのに)署名してしまったケース
    const signature = await signVoucher(stranger, address, chainId, voucher);

    await expect(contract.connect(participant).claim(voucher, signature)).to.be.revertedWith(
      "IchigoGachaNFT: invalid signature"
    );
  });

  it("owner以外はsetTrustedMinter/setURIを呼べない", async function () {
    const { contract, participant } = await deployFixture();
    await expect(
      contract.connect(participant).setTrustedMinter(participant.address)
    ).to.be.revertedWithCustomError(contract, "OwnableUnauthorizedAccount");
    await expect(
      contract.connect(participant).setURI("https://example.test/other/{id}.json")
    ).to.be.revertedWithCustomError(contract, "OwnableUnauthorizedAccount");
  });
});
