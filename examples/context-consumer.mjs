import {
  ConversationManager,
  parseContext,
  serializeContext,
} from "@propio-ai/agent/context";

// This consumer supplies all context explicitly and performs no filesystem I/O.
const context = new ConversationManager();
context.beginUserTurn("Explain the supplied text.");
const restored = new ConversationManager();
restored.importState(
  parseContext(serializeContext(context.getConversationState())),
);
const plan = restored.buildPromptPlan("Be concise.", undefined, {
  contextWindowTokens: 32000,
  supplementalContext: [
    "Supplied text: a context manager selects conversation history.",
  ],
});
console.log(JSON.stringify(plan, null, 2));
