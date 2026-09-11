# AI Hub —— 零依赖，所以镜像可以非常小
FROM node:20-alpine

WORKDIR /app

# 只拷运行需要的文件；config.json 故意不拷（含密钥），配置一律走环境变量
COPY server.js ./
COPY public ./public

ENV NODE_ENV=production
# 托管平台会注入自己的 PORT，这里只是本地 docker run 时的默认值
ENV PORT=8899

EXPOSE 8899

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8899)+'/api/auth-status',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
