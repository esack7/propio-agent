export interface PathToolOptions {
  /** Supplied by the public factory; legacy CLI constructors retain cwd behavior. */
  readonly resolvePath?: (rawPath: unknown) => string;
}
