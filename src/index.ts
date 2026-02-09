import * as readline from 'readline';
import * as path from 'path';
import { Agent } from './agent';

async function main() {
  // Load configuration from .propio/providers.json
  const configPath = path.join(__dirname, '..', '.propio', 'providers.json');

  const agent = new Agent({
    providersConfig: configPath,
    systemPrompt: `You are a helpful AI coding assistant with access to tools. Provide clear and concise answers.

You have access to the following tools:
- save_session_context: Save the session context to a file (call this after completing each user request)
- read_file: Read content from files on the filesystem
- write_file: Write content to files on the filesystem

When you use a tool, you will see the result and can use that information to continue helping the user. After using tools and completing the user's request, provide a final response summarizing what you did.`
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  console.log('AI Agent started. Type your message and press Enter.');
  console.log('Commands: /clear - clear context, /context - show context, /exit - quit\n');

  const prompt = () => {
    rl.question('You: ', async (input) => {
      const trimmedInput = input.trim();

      if (!trimmedInput) {
        prompt();
        return;
      }

      if (trimmedInput === '/exit') {
        console.log('Saving session context...');
        agent.saveContext('Exiting application');
        console.log('Goodbye!');
        rl.close();
        process.exit(0);
      }

      if (trimmedInput === '/clear') {
        agent.clearContext();
        console.log('Session context cleared.\n');
        prompt();
        return;
      }

      if (trimmedInput === '/context') {
        const context = agent.getContext();
        if (context.length === 0) {
          console.log('No session context.\n');
        } else {
          console.log('Session Context:');
          context.forEach((msg, index) => {
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
