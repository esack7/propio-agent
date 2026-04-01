#!/usr/bin/env node

const path = require("path");
const { pathToFileURL } = require("url");

const distIndexPath = path.resolve(__dirname, "..", "dist", "index.js");
process.argv[1] = distIndexPath;

import(pathToFileURL(distIndexPath).href).catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
