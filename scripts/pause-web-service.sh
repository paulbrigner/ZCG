#!/usr/bin/env bash
set -euo pipefail

AWS_PROFILE="${AWS_PROFILE:-zodldashboard}"
AWS_REGION="${AWS_REGION:-us-east-1}"
STACK_NAME="${STACK_NAME:-ZcgPrototypeStack}"
export AWS_PROFILE AWS_REGION

cluster_name="$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='WebServiceClusterName'].OutputValue | [0]" \
  --output text)"
service_name="$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='WebServiceName'].OutputValue | [0]" \
  --output text)"

if [[ -z "$cluster_name" || "$cluster_name" == "None" || "$cluster_name" == "disabled" ||
      -z "$service_name" || "$service_name" == "None" || "$service_name" == "disabled" ]]; then
  echo "No ECS web service is deployed in $STACK_NAME. It is already off in the current cost mode."
  exit 0
fi

aws ecs update-service \
  --cluster "$cluster_name" \
  --service "$service_name" \
  --desired-count 0 \
  --no-cli-pager >/dev/null

echo "Paused ECS web service $service_name in cluster $cluster_name."
