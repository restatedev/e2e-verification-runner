#!/usr/bin/env bash

export SERVICES=InterpreterDriverJob
export NODE_ENV=production
export NODE_OPTIONS="--max-old-space-size=4096"
export AWS_LAMBDA_FUNCTION_NAME=1

SEED=$(date --iso-8601=seconds)

export INTERPRETER_DRIVER_CONF=$(cat <<-EOF
{
	"seed"	: "${SEED}",
	"keys"	: 100,
	"tests" : 100,
	"maxProgramSize"	:  20,
	"bootstrap"				: false,
	"ingress" : ["http://localhost:8080"]
}
EOF
)

node dist/app.js


