#!/usr/bin/env bash

# The driver is piped into `tee` at the end so its output is also captured to a
# file that CI uploads as an artifact (the GitHub run-log archive is too large
# to download reliably). pipefail makes the script's exit status reflect the
# driver's exit rather than tee's.
set -o pipefail

#
# input parameters to this script, they all have defaults
#
export DRIVER_IMAGE=${DRIVER_IMAGE:-"ghcr.io/restatedev/e2e-verification-runner:main"}
export RESTATE_CONTAINER_IMAGE=${RESTATE_CONTAINER_IMAGE:-"ghcr.io/restatedev/restate:main"}
export RESTATE_RELEASED_CONTAINER_IMAGE=${RESTATE_RELEASED_CONTAINER_IMAGE:-"restatedev/restate:1.6.2"}
export SERVICES_CONTAINER_IMAGE=${SERVICES_CONTAINER_IMAGE:-"ghcr.io/restatedev/test-services-node:main"}
export ENV_FILE=${ENV_FILE:-"correctness/env.json"}
export PARAMS_FILE=${PARAMS_FILE:-"correctness/params.json"}
export MODE=${MODE:-"forward"}


SEED=$(date --iso-8601=seconds)

#
# template a string file
#
function template_json() {
	local tmpfile=$(mktemp)

	echo "local template=\$(cat <<-EOF" >> $tmpfile
	cat $1 >> $tmpfile
	echo "" >> $tmpfile
	echo "EOF" >> $tmpfile
	echo ")" >> $tmpfile

	source $tmpfile
	rm $tmpfile

	echo $template
}

function fix_path() {
	local file_path=$1

	if [ -f $file_path  ]; then
		echo $file_path
		return 0
	fi

	local script_dir=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )
	local local_file_path="${script_dir}/${file_path}"

	if [ -f $local_file_path  ]; then
		echo $local_file_path
		return 0
	fi

	echo "could not find ${file_path} or ${local_file_path}"
	exit 1

}

docker pull ${DRIVER_IMAGE}
docker pull ${RESTATE_CONTAINER_IMAGE}
docker pull ${RESTATE_RELEASED_CONTAINER_IMAGE}
docker pull ${SERVICES_CONTAINER_IMAGE}

# log configuration parameters
echo "Driver ================================================"
echo ${DRIVER_IMAGE}
docker inspect ${DRIVER_IMAGE} | grep org.opencontainers.image.revision

echo "RESTATE ================================================"
echo ${RESTATE_CONTAINER_IMAGE}
docker inspect ${RESTATE_CONTAINER_IMAGE} | grep org.opencontainers.image.revision

echo "RESTATE (released) ========================================="
echo ${RESTATE_RELEASED_CONTAINER_IMAGE}
docker inspect ${RESTATE_RELEASED_CONTAINER_IMAGE} | grep org.opencontainers.image.revision

echo "SERVICE ================================================"
echo ${SERVICES_CONTAINER_IMAGE}
docker inspect ${SERVICES_CONTAINER_IMAGE} | grep org.opencontainers.image.revision

echo "======================================================="

export ENV_FILE=$(fix_path ${ENV_FILE})
export PARAMS_FILE=$(fix_path ${PARAMS_FILE})

echo ${ENV_FILE}
echo ${PARAMS_FILE}

#
# The following ENV is needed for the driver program itself.
#
export MOUNT_DIR=$(mktemp -d)
echo "MOUNT_DIR=${MOUNT_DIR}"

# Directory for all logs uploaded as a CI artifact: the driver's own output
# (verification.log) plus one file per container, written by the driver into the
# mounted container-logs dir.
export LOG_DIR=${LOG_DIR:-"$(pwd)/logs"}
export CONTAINER_LOGS_DIR_HOST="${LOG_DIR}/containers"
mkdir -p "${CONTAINER_LOGS_DIR_HOST}"
export VERIFICATION_LOG="${VERIFICATION_LOG:-${LOG_DIR}/verification.log}"

export INTERPRETER_DRIVER_CONF=$(template_json ${PARAMS_FILE})
export UNIVERSE_ENV_JSON=$(template_json ${ENV_FILE})
export SERVICES=InterpreterDriverJob
export NODE_ENV=production
export NODE_OPTIONS="--max-old-space-size=4096"
export AWS_LAMBDA_FUNCTION_NAME=1

if [ -n "${DISABLE_CLEANUP}" ]; then
	export TESTCONTAINERS_RYUK_DISABLED=true
fi

docker run \
	--net host\
	-v /var/run/docker.sock:/var/run/docker.sock	\
	--env SERVICES	\
	--env NODE_ENV \
	--env NODE_OPTIONS \
	--env AWS_LAMBDA_FUNCTION_NAME \
	-v "${CONTAINER_LOGS_DIR_HOST}":/container-logs \
	--env CONTAINER_LOGS_DIR=/container-logs \
	--env INTERPRETER_DRIVER_CONF \
	--env UNIVERSE_ENV_JSON \
	--env DISABLE_CLEANUP \
	--env TESTCONTAINERS_RYUK_DISABLED \
	--env STUCK_DETECTOR_DUMP_GOROUTINES \
	--env STUCK_DETECTOR_TIMEOUT_SECONDS \
	--env STUCK_DETECTOR_DISABLED \
	--env INTERPRETER_JOURNAL_RETENTION \
	${DRIVER_IMAGE} 2>&1 | tee "${VERIFICATION_LOG:-verification.log}"
