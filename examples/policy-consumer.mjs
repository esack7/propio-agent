// A standalone policy consumer: no CLI configuration, filesystem, or terminal.
import { InMemoryPermissionStore, PolicyEngine } from "@propio-ai/agent/policy";

const store = new InMemoryPermissionStore({
  demo: {
    allow: ["bash(npm test)"],
    ask: [],
    deny: ["bash(git push:*)", "edit(secrets/**)"],
  },
});
const policy = await PolicyEngine.create({
  store,
  owner: "demo",
  workspaceRoot: "/work/project",
});

const write = {
  capabilities: ["workspace_write"],
  readOnly: false,
  concurrencySafe: false,
};
const shell = {
  capabilities: ["process"],
  readOnly: false,
  concurrencySafe: false,
};
const edit = (path) => ({
  toolName: "edit",
  args: { path },
  metadata: write,
  target: { kind: "path", path },
});
const bash = (command) => ({
  toolName: "bash",
  args: { command },
  metadata: shell,
  target: { kind: "command", command },
});

const decisions = {
  allowedByRule: policy.evaluate(bash("npm test")),
  deniedByRule: policy.evaluate(bash("npm test && git push")),
  deniedPath: policy.evaluate(edit("/work/project/secrets/key.pem")),
};

// An undecided call becomes a JSON request that any process can answer.
const pending = policy.evaluate(edit("/work/project/src/index.ts"));
const wire = JSON.parse(JSON.stringify(pending.request));
const answered = await policy.answer({
  requestId: wire.id,
  decision: "allow_session",
  rule: wire.suggestions[0].rule,
});

// Session grants are plain strings: save them with the session, restore on resume.
const resumed = await PolicyEngine.create({
  store,
  owner: "demo",
  workspaceRoot: "/work/project",
});
resumed.restoreSessionGrants(policy.listSessionGrants());

console.log(
  JSON.stringify(
    {
      ...Object.fromEntries(
        Object.entries(decisions).map(([name, { outcome, rule }]) => [
          name,
          { outcome, rule },
        ]),
      ),
      asked: {
        reason: wire.reason,
        suggestions: wire.suggestions.map((s) => s.rule),
      },
      answered: { outcome: answered.outcome, actor: answered.actor },
      afterGrant: policy.evaluate(edit("/work/project/src/index.ts")).outcome,
      sessionGrants: policy.listSessionGrants(),
      afterResume: resumed.evaluate(edit("/work/project/src/index.ts")).outcome,
    },
    null,
    2,
  ),
);
