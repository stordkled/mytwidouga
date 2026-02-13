FROM ghcr.io/puppeteer/puppeteer:21.11.0

USER root
WORKDIR /app

COPY package.json ./

# puppeteer-core is tiny (~1MB), installs in seconds
RUN npm install --production

COPY . .
RUN mkdir -p icons

EXPOSE 3000

USER pptruser

CMD ["node", "server.js"]
