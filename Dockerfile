FROM node:18-alpine

# Install required system dependencies
# poppler-utils provides pdftoppm command
RUN apk add --no-cache \
    poppler-utils

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including dev dependencies for build)
RUN npm ci

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Remove dev dependencies to reduce image size
RUN npm prune --production

# Create necessary directories with proper permissions
RUN mkdir -p uploads temp && \
    chown -R node:node uploads temp

EXPOSE 3000

# Switch to node user for security
USER node

CMD ["npm", "start"]