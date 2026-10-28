import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

// This is separate from ESO. The kubelet/container runtime on each EC2 node
// assumes this instance-profile role to pull workload container images.
export function createNodeRole(scope: Construct, roleName: string): iam.Role {
  return new iam.Role(scope, 'NodeRole', {
    roleName,
    assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
    managedPolicies: [
      iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSWorkerNodePolicy'),
      iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKS_CNI_Policy'),
      iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ContainerRegistryReadOnly'),
      iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
    ],
  });
}
