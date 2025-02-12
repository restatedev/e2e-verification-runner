FROM node:23 AS build

WORKDIR /usr/src/app
COPY . .

RUN npm install
RUN npm run build

FROM node:23 AS prod
WORKDIR /usr/src/app

# Install app dependencies
COPY --from=build /usr/src/app/dist/app.js /usr/src/app/app.js

EXPOSE 8080
CMD ["node", "/usr/src/app/app.js"]
