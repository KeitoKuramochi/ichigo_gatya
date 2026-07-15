require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY || "";
const accounts = DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [];

/** @type {import("hardhat/config").HardhatUserConfig} */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // OpenZeppelin 5.6系がmcopy(EIP-5656, Cancun)を使うため明示的に指定。
      // OptimismはEcotoneアップグレードでCancun相当のEVM opcodeに対応済み。
      evmVersion: "cancun",
    },
  },
  networks: {
    optimism: {
      url: process.env.OPTIMISM_RPC_URL || "https://mainnet.optimism.io",
      chainId: 10,
      accounts,
    },
    optimismSepolia: {
      url: process.env.OPTIMISM_SEPOLIA_RPC_URL || "https://sepolia.optimism.io",
      chainId: 11155420,
      accounts,
    },
  },
  etherscan: {
    apiKey: {
      optimisticEthereum: process.env.OPTIMISTIC_ETHERSCAN_API_KEY || "",
    },
  },
};
