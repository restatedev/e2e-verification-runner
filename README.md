# Verification Runner

## Install and build

To get all the dependencies required to develop the node services:

```shell
$ npm install
```

To build:

```shell
$ npm run build
```

## Build and push the docker image:
A node services Docker image is used by the verification tests in Kubernetes.

```shell
$ docker build --platform linux/arm64,linux/amd64 -t ghcr.io/restatedev/e2e-verification-runner --push .
```

## Lint and format

Linting is run together with `gradle check`, you can format using:

```shell
$ npm run format
```

## Running the services

### As a webapp

```shell
SERVICES=InterpreterDriver node dist/app.js
```

## As a standalone job

```shell
SERVICES=InterpreterDriverJob node dist/app.js
```

## See [`run-verification.sh`](scripts/run-verification.sh)
