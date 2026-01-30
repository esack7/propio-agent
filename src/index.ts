import * as readline from 'readline';
import { Agent } from './agent';

async function main() {
  const agent = new Agent({
    model: process.env.OLLAMA_MODEL || 'qwen3-coder:30b',
    host: process.env.OLLAMA_HOST || 'http://localhost:11434',
    systemPrompt: 'You are a helpful AI coding assistant. Provide clear and concise answers.'
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  console.log('AI Agent started. Type your message and press Enter.');
  console.log('Commands: /clear - clear history, /history - show history, /exit - quit\n');

  const prompt = () => {
    rl.question('You: ', async (input) => {
      const trimmedInput = input.trim();

      if (!trimmedInput) {
        prompt();
        return;
      }

      if (trimmedInput === '/exit') {
        console.log('Goodbye!');
        rl.close();
        process.exit(0);
      }

      if (trimmedInput === '/clear') {
        agent.clearHistory();
        console.log('Conversation history cleared.\n');
        prompt();
        return;
      }

      if (trimmedInput === '/history') {
        const history = agent.getHistory();
        if (history.length === 0) {
          console.log('No conversation history.\n');
        } else {
          console.log('Conversation History:');
          history.forEach((msg, index) => {
            console.log(`${index + 1}. ${msg.role.toUpperCase()}: ${msg.content}`);
          });
          console.log('');
        }
        prompt();
        return;
      }

      try {
        process.stdout.write('Assistant: ');
        await agent.streamChat(trimmedInput, (token) => {
          process.stdout.write(token);
        });
        console.log('\n');
      } catch (error) {
        console.error(`\nError: ${error instanceof Error ? error.message : 'Unknown error'}\n`);
      }

      prompt();
    });
  };

  prompt();
}

main().catch(console.error);
