#!/usr/bin/env bash
set -euo pipefail

AWS_PROFILE="${AWS_PROFILE:-zodldashboard}"
AWS_REGION="${AWS_REGION:-us-east-1}"
STACK_NAME="${STACK_NAME:-ZcgPrototypeStack}"
DESIRED_COUNT="${1:-1}"
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
  cat <<EOF
No ECS web service is deployed in $STACK_NAME.

Re-enable the optional ECS/ALB web tier with:
  AWS_PROFILE=$AWS_PROFILE AWS_REGION=$AWS_REGION npm run infra:deploy -- -c costMode=prototype-low-cost -c enableWebService=true -c webDesiredCount=$DESIRED_COUNT -c removalPolicy=retain -c deletionProtection=true
EOF
  exit 1
fi

aws ecs update-service \
  --cluster "$cluster_name" \
  --service "$service_name" \
  --desired-count "$DESIRED_COUNT" \
  --no-cli-pager >/dev/null

echo "Resumed ECS web service $service_name in cluster $cluster_name to desiredCount=$DESIRED_COUNT."
