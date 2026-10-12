# OpenAI access in Propio

Run `propio setup openai` in a terminal. Choose API billing or Continue with ChatGPT, select/add an account label, choose an eligible model, then choose this session or a saved default. Subscription setup preserves saved budgets and uses documented defaults for recognized models. Existing OpenAI configurations keep API behavior. Sign-in alone does not change defaults or fall back to API billing.

```sh
propio auth login openai --account personal
propio auth status openai --account personal --json
propio auth accounts openai --json
propio setup openai
propio
```

In chat, `/model` selects access/account/model and `/account` manages sign-in, consent, logout and setup. Changing registration defaults to a new conversation. Transcript transfer is explicit and removes incompatible opaque continuation. Sessions retain safe account references; resume with the same registration. Background summaries use the selected account and consume allowance or permitted credits. [Manage usage](https://chatgpt.com/settings/usage) when a limit is reached; API billing is a deliberate selection.

The current model catalog supplies eligibility and names, not a verified context capacity. Propio uses an exact model-ID table checked against official model documentation on October 11, 2026. Recognized GPT-6 and GPT-5.6 variants, plus GPT-5.5 and its documented snapshot, have a 1,050,000-token context window and a 128,000-token maximum output allowance. The automatic working context budget is 922,000 tokens: it reserves the full output allowance and respects documented input limits. The context planner subtracts its own additional output reserve from this working ceiling. [GPT-6.1 Sol limits](https://developers.openai.com/api/docs/models/gpt-6.1-sol), [GPT-5.5 limits](https://developers.openai.com/api/docs/models/gpt-5.5).

Saved model budgets, including an earlier conservative 128,000 selection, remain unchanged. In setup or `/model`, choose **3. Adjust prompt budget** before applying the selection. Enter `documented` to use the automatic budget, `conservative` for 128,000, or a verified integer of at least 1,024 tokens. Choose this session or save for future sessions afterward. Unknown model IDs and future snapshots still require an explicit verified or conservative budget. Saved budgets live in `providers.json`; session choices and cancelled selections do not write a separate budget file. The built-in documentation table retains source URLs, check dates and limits; the catalog does not supply these values. Documentation limits are defaults, not account-specific subscription entitlements; select a smaller budget if your subscription imposes a lower limit.

Text and local functions are supported; images, audio/video, uploads and hosted tools remain unsupported by this adapter.

## Credentials and recovery

macOS uses Keychain by default. Unix users may explicitly choose `--storage protected-file` during first login, or choose it in setup. That fallback writes owner-only files under `~/.local/share/propio/openai-secrets`; registry metadata is under `~/.propio/auth/openai`. Linux Secret Service is implemented but unverified in this change. Windows credential operations currently fail closed pending ACL verification. Missing native locking or secret-store support fails with an actionable error rather than silently selecting file storage.

```sh
propio auth enable-plan openai --account personal
propio auth login openai --account personal --no-browser
propio auth logout openai --account personal
```

Manual sign-in URLs omit saved ID/email hints. Do not share the URL or credentials. Logout retains the local registration and stable host identity, clears local tokens, and reports whether remote revocation was confirmed. Renewal is serialized across processes. An uncertain rotation requires sign-in again before another inference request. A disabled plan grant requires explicit consent. Errors never change provider, account, permitted-credit settings or billing automatically.

The optional same-host migration command is `propio auth import-poc openai --account personal --poc-account default`. Stop POC processes first. The command preserves its issued client/host identity, uses both locks, and retires only the selected source token set after a durable destination exists. It refuses collisions. Do not copy credential files manually. Migration was tested with simulated records; the original live POC was preserved and was not imported.

## Local implementation testing

Use Node 20+ with npm and native addon installation support. The agent uses the published `@propio-ai/providers@0.6.0` package; no local provider link is required. From the meta-repo:

```sh
cd specs/openai-subscription/repos/propio-agent
npm ci
npm run build
node dist/index.js auth login openai --account personal
node dist/index.js setup openai
node dist/index.js
```

When changing the provider and agent together, build the provider worktree and use the meta-repo's link-local-packages helper with `--spec openai-subscription`. Rerun the helper after npm install/ci if you need the local checkout. For those local sandbox builds, pack the provider into a `.tmp-packages` directory inside the agent checkout, then build with `--build-arg PROPIO_LOCAL_PROVIDERS_TARBALL=.tmp-packages/<provider-tarball>.tgz`. For example, from the agent worktree:

```sh
mkdir -p .tmp-packages
npm --prefix ../propio-providers pack --pack-destination "$PWD/.tmp-packages"
docker compose -f docker-compose.yml build --build-arg PROPIO_LOCAL_PROVIDERS_TARBALL=.tmp-packages/propio-ai-providers-0.1.4.tgz agent
./bin/propio-sandbox
```

This builds the local sandbox image used by the wrapper; it may replace your previous local image with the same compose service tag. Normal builds use the published provider and need no local tarball override.

Sandbox integration is a macOS transport preview, exercised with Colima and dummy access tokens. The host wrapper keeps refresh/ID tokens outside mounts, renews through a scoped broker and gives a filtered configuration view to the container. Choose the intended subscription as the saved default before starting the sandbox. Manage accounts on the host and restart to change scope. Native Linux/Windows subscription sandbox startup is blocked; Docker Desktop and real expiry/long-session acceptance are pending. API sandbox remains available.

For live acceptance, use a harmless workspace read, an already configured client MCP function, a follow-up referring to the prior answer, save/resume under the same registration, and enough context to trigger a summary. Repeat after access-token expiry and logout/relogin; verify plan/account labels and usage disclosure. These checks consume allowance. Do not exhaust an account to test limits.

See the meta-repo `specs/openai-subscription/verification.md` for actual results and unresolved release gates. The POC's live successes are provenance, not production acceptance.
