FROM node:22-alpine
WORKDIR /app
COPY server/package*.json ./
RUN npm install --omit=dev
COPY server .
EXPOSE 7860
ENV PORT=7860
CMD ["node", "server.mjs"]
