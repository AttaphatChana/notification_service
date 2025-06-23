# 1) Build stage
FROM node:18-alpine AS builder
WORKDIR /app

# Install dependencies
COPY package*.json tsconfig.json ./
RUN npm install

# Copy source and build
COPY src ./src
RUN npm run build

# 2) Run stage
FROM node:18-alpine
WORKDIR /app

# Copy only production deps and build output
COPY package*.json ./
RUN npm install --only=production
COPY --from=builder /app/dist ./dist

# Expose port and start
EXPOSE 3000
CMD ["node", "dist/index.js"]