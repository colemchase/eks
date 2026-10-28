import * as cdk from 'aws-cdk-lib';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as iam from 'aws-cdk-lib/aws-iam';

export interface ExternalSecretsIdentityProps {
  clusterName: string;
  environmentName: string;
  buildAccountId: string;
  podIdentityAgent: cdk.CfnResource;
}

// EKS Pod Identity trust. This is not IRSA and does not use an IAM OIDC provider.
function podIdentityPrincipal(scope: cdk.Stack): iam.IPrincipal {
  return new iam.SessionTagsPrincipal(
    new iam.ServicePrincipal('pods.eks.amazonaws.com', {
      conditions: {
        StringEquals: { 'aws:SourceAccount': scope.account },
      },
    }),
  );
}

export function addExternalSecretsIdentity(
  scope: cdk.Stack,
  props: ExternalSecretsIdentityProps,
): iam.Role {
  const role = new iam.Role(scope, 'ExternalSecretsRole', {
    roleName: `${props.clusterName}-external-secrets`,
    assumedBy: podIdentityPrincipal(scope),
  });

  // Environment-owned application secrets read by ESO.
  role.addToPolicy(new iam.PolicyStatement({
    actions: ['secretsmanager:DescribeSecret', 'secretsmanager:GetSecretValue'],
    resources: [
      `arn:aws:secretsmanager:${scope.region}:${scope.account}:secret:platform/${props.environmentName}/*`,
      `arn:aws:secretsmanager:${scope.region}:${scope.account}:secret:randomrooms/${props.environmentName}/*`,
    ],
  }));

  // Current ECR-chart design: ESO assumes the shared Build role.
  role.addToPolicy(new iam.PolicyStatement({
    actions: ['sts:AssumeRole', 'sts:TagSession'],
    resources: [
      `arn:aws:iam::${props.buildAccountId}:role/build-helm-chart-reader`,
      `arn:aws:iam::${props.buildAccountId}:role/build-github-app-secret-reader`,
    ],
  }));

  // This is the full ServiceAccount-to-IAM-role binding for EKS Pod Identity.
  // There is no eks.amazonaws.com/role-arn annotation on the ServiceAccount.
  const association = new eks.CfnPodIdentityAssociation(scope, 'ExternalSecretsPodIdentity', {
    clusterName: props.clusterName,
    namespace: 'external-secrets',
    serviceAccount: 'external-secrets',
    roleArn: role.roleArn,
  });
  association.node.addDependency(props.podIdentityAgent);

  return role;
}
