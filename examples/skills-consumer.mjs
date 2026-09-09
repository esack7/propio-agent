// A standalone metadata catalog consumer; no CLI configuration or agent execution.
import { loadSkills, renderSkillDiscoveryBlock } from "@propio-ai/agent/skills";

const [workspaceRoot, rootsJson] = process.argv.slice(2);
if (!workspaceRoot || !rootsJson) {
  throw new Error(
    `Usage: npm run example:skills -- /absolute/workspace '[{"source":"project","skillRoot":"/absolute/skills"}]'`,
  );
}
const { registry, diagnostics } = loadSkills({
  workspaceRoot,
  roots: JSON.parse(rootsJson),
});
console.log(
  JSON.stringify(
    {
      skills: registry.list(),
      diagnostics,
      discovery: renderSkillDiscoveryBlock(registry.listModelInvocable()),
    },
    null,
    2,
  ),
);
