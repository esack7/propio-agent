module.exports = {
  preset: "ts-jest/presets/default-esm",
  testEnvironment: "node",
  injectGlobals: true,
  setupFilesAfterEnv: ["<rootDir>/jest.setup.js"],
  extensionsToTreatAsEsm: [".ts"],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        useESM: true,
        isolatedModules: true,
      },
    ],
  },
  roots: ["<rootDir>/src"],
  testMatch: ["**/__tests__/**/*.test.ts"],
  moduleFileExtensions: ["ts", "tsx", "js", "jsx", "json", "node"],
  collectCoverageFrom: ["src/**/*.ts", "!src/**/*.test.ts", "!src/**/index.ts"],
};
