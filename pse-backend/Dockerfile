FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package.json .
RUN npm install --production

# Copy source
COPY . .

# Create data directory for scraped files
RUN mkdir -p data

EXPOSE 3001

CMD ["node", "server.js"]
