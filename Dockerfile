FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY tsconfig.json ./
COPY src ./src

# Build TypeScript
RUN npm run build

# Set default environment variables
ENV OLLAMA_HOST=http://host.docker.internal:11434
ENV OLLAMA_MODEL=qwen3-coder:30b

# Run the agent
CMD ["npm", "start"]
