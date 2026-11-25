import { DurableEventLog } from "../../durableEventLog.ts";
const [filename, cursor, append] = process.argv.slice(2);
const log = new DurableEventLog(filename);
const records = log.after(Number(cursor));
if (append) log.append(JSON.parse(append));
process.stdout.write(
  JSON.stringify({ records, lastSequence: log.lastSequence }),
);
