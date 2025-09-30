FROM node:18-alpine as build
WORKDIR /app
ARG API_BASE_URL=https://p2p.example.com
ENV API_BASE_URL=$API_BASE_URL
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
FROM node:18-alpine
WORKDIR /app
RUN npm install -g serve
COPY --from=build /app/dist ./dist
EXPOSE 3000
ENV PORT=3000
ENV API_BASE_URL=$API_BASE_URL
CMD ["sh", "-c", "serve -s dist -l $PORT"]
