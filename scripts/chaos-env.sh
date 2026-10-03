#!/usr/bin/env bash
# Create (or reuse) a disposable kind cluster with Chaos Mesh and the Restate
# operator installed, and make it the current kubectl context for `npm run chaos`.
set -euo pipefail

CLUSTER=${KIND_CLUSTER:-restate-chaos}
KIND_IMAGE=${KIND_IMAGE:-"kindest/node:v1.35.5@sha256:ce977ae6d65918d0b58a5f8b5e940429c2ce42fa3a5619ec2bbc60b949c0ac95"}
CHAOS_MESH_VERSION=${CHAOS_MESH_VERSION:-2.8.3}
OPERATOR_CHART_VERSION=${OPERATOR_CHART_VERSION:-3.1.0}

if ! kind get clusters 2>/dev/null | grep -qx "${CLUSTER}"; then
	kind create cluster --name "${CLUSTER}" --image "${KIND_IMAGE}" --wait 120s
fi
kubectl config use-context "kind-${CLUSTER}"

helm upgrade --install chaos-mesh chaos-mesh \
	--repo https://charts.chaos-mesh.org --version "${CHAOS_MESH_VERSION}" \
	--namespace chaos-mesh --create-namespace --wait --timeout 180s \
	--set dashboard.create=false \
	--set chaosDaemon.runtime=containerd \
	--set chaosDaemon.socketPath=/run/containerd/containerd.sock

helm upgrade --install restate-operator oci://ghcr.io/restatedev/restate-operator-helm \
	--version "${OPERATOR_CHART_VERSION}" \
	--namespace restate-operator --create-namespace --wait --timeout 180s

echo "Ready: kind cluster ${CLUSTER} with Chaos Mesh ${CHAOS_MESH_VERSION} and operator chart ${OPERATOR_CHART_VERSION}"
echo "Remove it with: kind delete cluster --name ${CLUSTER}"
