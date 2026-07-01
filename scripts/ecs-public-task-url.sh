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
  echo "No ECS web service is deployed in $STACK_NAME."
  exit 1
fi

task_arn="$(aws ecs list-tasks \
  --cluster "$cluster_name" \
  --service-name "$service_name" \
  --desired-status RUNNING \
  --query "taskArns[0]" \
  --output text)"

if [[ -z "$task_arn" || "$task_arn" == "None" ]]; then
  echo "No running ECS task found for $service_name."
  exit 1
fi

eni_id="$(aws ecs describe-tasks \
  --cluster "$cluster_name" \
  --tasks "$task_arn" \
  --query "tasks[0].attachments[0].details[?name=='networkInterfaceId'].value | [0]" \
  --output text)"
public_ip="$(aws ec2 describe-network-interfaces \
  --network-interface-ids "$eni_id" \
  --query "NetworkInterfaces[0].Association.PublicIp" \
  --output text)"

if [[ -z "$public_ip" || "$public_ip" == "None" ]]; then
  echo "Running task does not have a public IP. Use the AppUrl stack output if ALB is enabled."
  exit 1
fi

echo "http://$public_ip:3000"
