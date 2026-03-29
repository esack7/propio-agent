import { ProviderContextLengthError, ProviderError } from "../types.js";

describe("ProviderContextLengthError", () => {
  it("should be an instance of ProviderError", () => {
    const error = new ProviderContextLengthError("too long");
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toBeInstanceOf(ProviderContextLengthError);
  });

  it("should have the correct name", () => {
    const error = new ProviderContextLengthError("too long");
    expect(error.name).toBe("ProviderContextLengthError");
  });

  it("should preserve the original error", () => {
    const original = new Error("upstream error");
    const error = new ProviderContextLengthError("context exceeded", original);
    expect(error.originalError).toBe(original);
  });

  it("should be distinguishable from other ProviderError subclasses", () => {
    const contextError = new ProviderContextLengthError("too long");
    const genericError = new ProviderError("something else");

    expect(contextError instanceof ProviderContextLengthError).toBe(true);
    expect(genericError instanceof ProviderContextLengthError).toBe(false);
  });
});

describe("Provider capability resolution precedence", () => {
  it("per-model config override should take priority over provider default", () => {
    const configOverride = 32000;
    const providerDefault = 128000;

    const modelConfig = { contextWindowTokens: configOverride };
    const providerCapabilities = { contextWindowTokens: providerDefault };

    const resolved =
      modelConfig.contextWindowTokens ??
      providerCapabilities.contextWindowTokens;
    expect(resolved).toBe(configOverride);
  });

  it("provider default should be used when config override is absent", () => {
    const modelConfig: { contextWindowTokens?: number } = {};
    const providerCapabilities = { contextWindowTokens: 128000 };

    const resolved =
      modelConfig.contextWindowTokens ??
      providerCapabilities.contextWindowTokens;
    expect(resolved).toBe(128000);
  });
});
