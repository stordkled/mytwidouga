FROM ghcr.io/puppeteer/puppeteer:21.11.0

# Use root user to install dependencies if needed, though puppeteer image has pptruser
USER root

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
# We use npm ci for reliable builds
RUN npm ci

# Copy app source
COPY . .

# Create icons directory if it doesn't exist (though it should be copied)
RUN mkdir -p icons

# Expose port (Render/Railway set PORT env var, but we expose 3000 as default)
EXPOSE 3000

# Switch back to non-root user for security
USER pptruser

# Start the server
CMD ["node", "server.js"]
