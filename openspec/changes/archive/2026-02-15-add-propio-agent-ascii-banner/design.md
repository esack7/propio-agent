## Context

The CLI entrypoint is `src/index.ts`. It currently runs sandbox delegation first, then loads config and agents and starts the main loop. There is no startup branding. The `src/ui/` layer already provides formatting (`formatting.ts`, `colors.ts`) and is the right place for any new CLI output helpers.

## Goals / Non-Goals

**Goals:**

- Show a single "Propio Agent" ASCII banner at the very start of each normal run.
- Keep banner content fixed (PROPIO block + "A G E N T" line) and easy to maintain.
- Do not show the banner when the process delegates to sandbox (e.g. `--sandbox`) so the wrapper’s behavior stays unchanged.

**Non-Goals:**

- No configurable or environment-based suppression (e.g. no `NO_BANNER` flag for this change).
- No animation or dynamic content; static text only.

## Decisions

1. **When to print**  
   Print the banner immediately after sandbox delegation returns without delegating (i.e. at the start of the normal path), before `getConfigPath()` or any other user-visible work. So: first thing in `main()` after the `maybeRunSandboxDelegation` block.

2. **Where the banner lives**  
   Add a small helper (e.g. `printStartupBanner()` or a constant + single print call) in `src/ui/` (e.g. `src/ui/banner.ts` or inline in a shared formatting module). Reuse existing stdout and, if desired, existing chalk/formatting for consistency. Alternative: inline the string and `console.log` in `index.ts`; rejected so all CLI output stays behind the ui layer.

3. **Content storage**  
   Store the ASCII art as a single string constant (or multi-line template) in that ui module so the banner is easy to update and test. No file or network fetch.

4. **Styling**  
   Use existing `src/ui` styling (e.g. chalk via `formatting.ts`/`colors.ts`) if we want color; otherwise plain text is acceptable. Prefer consistency with the rest of the CLI over fancy styling.

## Risks / Trade-offs

- **Extra line noise for scripts**  
  Scripts that parse stdout may see the banner. Mitigation: keep the change to a single, small addition; if script-friendly mode is needed later, it can be a separate change (e.g. `--quiet` or no-TTY detection).

- **No behavioral risk**  
  Purely additive output; no config or API changes.
