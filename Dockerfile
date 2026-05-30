FROM node:22-alpine

WORKDIR /app

# 先复制依赖文件，安装依赖
COPY package*.json ./
RUN npm install

# 再复制源码
COPY . .
RUN npm run build

# 数据目录
RUN mkdir -p /app/data

EXPOSE 3000

CMD ["node", "dist/index.js"]