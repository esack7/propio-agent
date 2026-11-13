// Adds rules to one settings file from a separate process, one update each.
import { FilePermissionStore } from "../../permissionStore.ts";

const [filePath, prefix, count] = process.argv.slice(2);
const store = new FilePermissionStore({ filePath, owner: "local" });
for (let index = 0; index < Number(count); index += 1) {
  await store.update("local", (current) => ({
    ...current,
    deny: [...current.deny, `bash(${prefix}-${index})`],
  }));
}
