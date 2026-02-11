FROM node:20-alpine

# Build context
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

# Create workspace directory
RUN mkdir -p /workspace

# Runtime context
WORKDIR /workspace

# Run the agent with absolute path
CMD ["node", "/app/dist/index.js"]
