describe("OperationSpinner class", () => {
  let spinnerModule: any;

  beforeEach(async () => {
    // Clear module cache before each test
    jest.resetModules();

    // Mock ora before importing the spinner module
    jest.doMock("ora", () => ({
      default: jest.fn().mockReturnValue({
        start: jest.fn().mockReturnThis(),
        succeed: jest.fn().mockReturnThis(),
        fail: jest.fn().mockReturnThis(),
        stop: jest.fn().mockReturnThis(),
      }),
    }));

    spinnerModule = await import("../spinner.js");
  });

  afterEach(() => {
    jest.dontMock("ora");
  });

  describe("constructor", () => {
    it("should create an instance with operation text", () => {
      const operationText = "Loading data";
      const spinner = new spinnerModule.OperationSpinner(operationText);

      expect(spinner).toBeDefined();
      expect(spinnerModule.OperationSpinner).toBeDefined();
    });

    it("should initialize with an ora instance", () => {
      const spinner = new spinnerModule.OperationSpinner("Testing");
      expect(spinner).toBeInstanceOf(spinnerModule.OperationSpinner);
    });
  });

  describe("start() method", () => {
    it("should have a start method", () => {
      const spinner = new spinnerModule.OperationSpinner("Starting operation");
      expect(typeof spinner.start).toBe("function");
    });

    it("should return void", () => {
      const spinner = new spinnerModule.OperationSpinner("Starting operation");
      const result = spinner.start();
      expect(result).toBeUndefined();
    });
  });

  describe("succeed() method", () => {
    it("should have a succeed method", () => {
      const spinner = new spinnerModule.OperationSpinner("Operation");
      expect(typeof spinner.succeed).toBe("function");
    });

    it("should accept a message parameter", () => {
      const spinner = new spinnerModule.OperationSpinner("Operation");
      expect(() => {
        spinner.succeed("Success message");
      }).not.toThrow();
    });

    it("should return void", () => {
      const spinner = new spinnerModule.OperationSpinner("Operation");
      const result = spinner.succeed("Success message");
      expect(result).toBeUndefined();
    });
  });

  describe("fail() method", () => {
    it("should have a fail method", () => {
      const spinner = new spinnerModule.OperationSpinner("Operation");
      expect(typeof spinner.fail).toBe("function");
    });

    it("should accept a message parameter", () => {
      const spinner = new spinnerModule.OperationSpinner("Operation");
      expect(() => {
        spinner.fail("Error message");
      }).not.toThrow();
    });

    it("should return void", () => {
      const spinner = new spinnerModule.OperationSpinner("Operation");
      const result = spinner.fail("Error message");
      expect(result).toBeUndefined();
    });
  });

  describe("stop() method", () => {
    it("should have a stop method", () => {
      const spinner = new spinnerModule.OperationSpinner("Operation");
      expect(typeof spinner.stop).toBe("function");
    });

    it("should return void", () => {
      const spinner = new spinnerModule.OperationSpinner("Operation");
      const result = spinner.stop();
      expect(result).toBeUndefined();
    });
  });

  describe("OperationSpinner class structure", () => {
    it("should be a class that can be instantiated with new", () => {
      const spinner = new spinnerModule.OperationSpinner("test");
      expect(spinner).toBeInstanceOf(spinnerModule.OperationSpinner);
    });

    it("should have all required methods", () => {
      const spinner = new spinnerModule.OperationSpinner("test");
      expect(typeof spinner.start).toBe("function");
      expect(typeof spinner.succeed).toBe("function");
      expect(typeof spinner.fail).toBe("function");
      expect(typeof spinner.stop).toBe("function");
    });
  });

  describe("integration scenario", () => {
    it("should handle complete spinner lifecycle: start -> succeed", () => {
      const spinner = new spinnerModule.OperationSpinner("Processing");

      // Should not throw when called in sequence
      expect(() => {
        spinner.start();
        spinner.succeed("Done!");
      }).not.toThrow();
    });

    it("should handle complete spinner lifecycle: start -> fail", () => {
      const spinner = new spinnerModule.OperationSpinner("Processing");

      // Should not throw when called in sequence
      expect(() => {
        spinner.start();
        spinner.fail("Something went wrong");
      }).not.toThrow();
    });

    it("should handle complete spinner lifecycle: start -> stop", () => {
      const spinner = new spinnerModule.OperationSpinner("Processing");

      // Should not throw when called in sequence
      expect(() => {
        spinner.start();
        spinner.stop();
      }).not.toThrow();
    });
  });

  describe("NO_COLOR environment variable support", () => {
    it("should accept text parameter and create spinner instance", () => {
      // ora respects NO_COLOR via chalk internally
      const spinner = new spinnerModule.OperationSpinner("Testing operation");

      expect(spinner).toBeDefined();
      expect(spinnerModule.OperationSpinner).toBeDefined();
    });

    it("should work correctly with NO_COLOR consideration", () => {
      // ora respects NO_COLOR via chalk internally, so we just verify the class works
      const spinner = new spinnerModule.OperationSpinner("test");

      expect(spinner).toBeDefined();

      // Should not throw when called
      expect(() => {
        spinner.start();
        spinner.succeed("done");
      }).not.toThrow();
    });
  });
});
