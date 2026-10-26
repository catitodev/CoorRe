import { defineConfig } from "hardhat/config";

export default defineConfig({
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
      evmVersion: "paris",
    },
  },
  paths: {
    sources: "contracts",
    cache: ".cache/hardhat",
    artifacts: ".cache/artifacts",
  },
});
